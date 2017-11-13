/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, commands, MessageItem } from 'vscode';
import { AzureAccount, AzureSession } from './azure-account.api';
import { createServer, readJSON, Queue } from './ipc';
import { getUserSettings, provisionConsole, Errors, resetConsole } from './cloudConsoleLauncher';
import * as nls from 'vscode-nls';
import * as path from 'path';
import * as opn from 'opn';
import * as cp from 'child_process';
import * as semver from 'semver';
import TelemetryReporter from 'vscode-extension-telemetry';

const localize = nls.loadMessageBundle();

export interface OS {
	id: string;
	shellName: string;
	otherOS: OS;
}

export const OSes: Record<string, OS> = {
	Linux: {
		id: 'linux',
		shellName: localize('azure-account.bash', "Bash"),
		get otherOS() { return OSes.Windows; },
	},
	Windows: {
		id: 'windows',
		shellName: localize('azure-account.powershell', "PowerShell"),
		get otherOS() { return OSes.Linux; },
	}
};

export function openCloudConsole(api: AzureAccount, reporter: TelemetryReporter, os: OS) {
	return () => {
		return (async function (): Promise<any> {

			const isWindows = process.platform === 'win32';
			if (isWindows) {
				// See below
				try {
					const { stdout } = await exec('node.exe --version');
					const version = stdout[0] === 'v' && stdout.substr(1).trim();
					if (version && semver.valid(version) && !semver.gte(version, '6.0.0')) {
						return requiresNode(reporter);
					}
				} catch (err) {
					return requiresNode(reporter);
				}
			}

			const loginStatus = await waitForLoginStatus(api);
			if (loginStatus === 'LoggedOut') {
				reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'requiresLogin' });
				return commands.executeCommand('azure-account.askForLogin');
			}

			// ipc
			const queue = new Queue<any>();
			const ipc = await createServer('vscode-cloud-console', async (req, res) => {
				for (const message of await readJSON<any>(req)) {
					if (message.type === 'log') {
						console.log(...message.args);
					}
				}

				res.write(JSON.stringify(await queue.dequeue()));
				res.end();
			});

			// open terminal
			let shellPath = path.join(__dirname, `../../bin/node.${isWindows ? 'bat' : 'sh'}`);
			let modulePath = path.join(__dirname, 'cloudConsoleLauncher');
			if (isWindows) {
				modulePath = modulePath.replace(/\\/g, '\\\\');
			}
			const shellArgs = [
				process.argv0,
				'-e',
				`require('${modulePath}').main()`,
			];

			if (isWindows) {
				// Work around https://github.com/electron/electron/issues/4218 https://github.com/nodejs/node/issues/11656
				shellPath = 'node.exe';
				shellArgs.shift();
			}

			const terminal = window.createTerminal({
				name: localize('azure-account.cloudConsole', "{0} in Cloud Shell", os.shellName),
				shellPath,
				shellArgs,
				env: {
					CLOUD_CONSOLE_IPC: ipc.ipcHandlePath,
				}
			});
			const subscription = window.onDidCloseTerminal(t => {
				if (t === terminal) {
					subscription.dispose();
					ipc.dispose();
				}
			});
			terminal.show();

			if (loginStatus !== 'LoggedIn') {
				queue.push({ type: 'log', args: [localize('azure-account.loggingIn', "Signing in...")] });
				if (!(await api.waitForLogin())) {
					queue.push({ type: 'log', args: [localize('azure-account.loginNeeded', "Sign in needed.")] });
					reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'requiresLogin' });
					await commands.executeCommand('azure-account.askForLogin');
					queue.push({ type: 'exit' });
					return;
				}
			}

			const tokens = await Promise.all(api.sessions.map(session => acquireToken(session)));
			const result = await findUserSettings(tokens);
			if (!result) {
				queue.push({ type: 'log', args: [localize('azure-account.setupNeeded', "Setup needed.")] });
				await requiresSetUp(reporter);
				queue.push({ type: 'exit' });
				return;
			}

			// provision
			const accessToken = result.token.accessToken;
			const armEndpoint = result.token.session.environment.resourceManagerEndpointUrl;
			const provision = async () => {
				const consoleUri = await provisionConsole(accessToken, armEndpoint, result.userSettings, os.id);
				reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'provisioned' });
				queue.push({
					type: 'connect',
					accessToken: accessToken,
					consoleUri
				});
			}
			try {
				queue.push({ type: 'log', args: [localize('azure-account.requestingCloudConsole', "Requesting a Cloud Shell...")] });
				await provision();
			} catch (err) {
				if (err && err.message === Errors.DeploymentOsTypeConflict) {
					const reset = await deploymentConflict(reporter, os);
					if (reset) {
						await resetConsole(accessToken, armEndpoint);
						return provision();
					} else {
						queue.push({ type: 'exit' });
						return;
					}
				} else {
					throw err;
				}
			}
		})().catch(err => {
			reporter.sendTelemetryEvent('openCloudConsole', {
				outcome: 'error',
				message: String(err && err.message || err)
			});
			throw err;
		});
	};
}

async function waitForLoginStatus(api: AzureAccount) {
	if (api.status !== 'Initializing') {
		return api.status;
	}
	return new Promise<typeof api.status>(resolve => {
		const subscription = api.onStatusChanged(() => {
			subscription.dispose();
			resolve(waitForLoginStatus(api));
		});
	});
}

async function findUserSettings(tokens: Token[]) {
	for (const token of tokens) {
		const userSettings = await getUserSettings(token.accessToken, token.session.environment.resourceManagerEndpointUrl);
		if (userSettings && userSettings.storageProfile) {
			return { userSettings, token };
		}
	}
}

async function requiresSetUp(reporter: TelemetryReporter) {
	reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'requiresSetUp' });
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const close: MessageItem = { title: localize('azure-account.close', "Close"), isCloseAffordance: true };
	const message = localize('azure-account.setUpInPortal', "First launch of Cloud Shell requires setup in the Azure portal (https://portal.azure.com).");
	const response = await window.showInformationMessage(message, open, close);
	if (response === open) {
		reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'requiresSetUpOpen' });
		opn('https://portal.azure.com');
	} else {
		reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'requiresSetUpCancel' });
	}
}

async function requiresNode(reporter: TelemetryReporter) {
	reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'requiresNode' });
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const close: MessageItem = { title: localize('azure-account.close', "Close"), isCloseAffordance: true };
	const message = localize('azure-account.requiresNode', "Opening a Cloud Shell currently requires Node.js 6 or later being installed (https://nodejs.org).");
	const response = await window.showInformationMessage(message, open, close);
	if (response === open) {
		reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'requiresNodeOpen' });
		opn('https://nodejs.org');
	} else {
		reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'requiresNodeCancel' });
	}
}

async function deploymentConflict(reporter: TelemetryReporter, os: OS) {
	reporter.sendTelemetryEvent('openCloudConsole', { outcome: 'deploymentConflict' });
	const ok: MessageItem = { title: localize('azure-account.ok', "OK") };
	const cancel: MessageItem = { title: localize('azure-account.cancel', "Cancel"), isCloseAffordance: true };
	const message = localize('azure-account.deploymentConflict', "Starting a {0} session will terminate all active {1} sessions. Any running processes in active {1} sessions will be terminated.", os.shellName, os.otherOS.shellName);
	const response = await window.showWarningMessage(message, ok, cancel);
	const reset = response === ok;
	reporter.sendTelemetryEvent('openCloudConsole', { outcome: reset ? 'deploymentConflictReset' : 'deploymentConflictCancel' });
	return reset;
}

interface Token {
	session: AzureSession;
	accessToken: string;
	refreshToken: string;
}

async function acquireToken(session: AzureSession) {
	return new Promise<Token>((resolve, reject) => {
		const credentials: any = session.credentials;
		const environment: any = session.environment;
		credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
			if (err) {
				reject(err);
			} else {
				resolve({
					session,
					accessToken: result.accessToken,
					refreshToken: result.refreshToken
				});
			}
		});
	});
}

export interface ExecResult {
	error: Error | null;
	stdout: string;
	stderr: string;
}


async function exec(command: string) {
	return new Promise<ExecResult>((resolve, reject) => {
		cp.exec(command, (error, stdout, stderr) => {
			(error || stderr ? reject : resolve)({ error, stdout, stderr });
		});
	});
}
