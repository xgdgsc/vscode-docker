/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, debug, DebugConfiguration, ExtensionContext, workspace, WorkspaceFolder } from 'vscode';
import { IActionContext, registerCommand } from 'vscode-azureextensionui';
import { initializeForDebugging } from '../commands/debugging/initializeForDebugging';
import { DockerRunTaskDefinition } from '../tasks/DockerRunTaskProvider';
import { DockerTaskScaffoldContext } from '../tasks/TaskHelper';
import ChildProcessProvider from './coreclr/ChildProcessProvider';
import CliDockerClient from './coreclr/CliDockerClient';
import { DockerServerReadyAction } from './DockerDebugConfigurationBase';
import { DockerDebugConfiguration, DockerDebugConfigurationProvider } from './DockerDebugConfigurationProvider';
import { DockerPlatform } from './DockerPlatformHelper';
import { registerServerReadyAction } from './DockerServerReadyAction';
import netCoreDebugHelper from './netcore/NetCoreDebugHelper';
import nodeDebugHelper from './node/NodeDebugHelper';
import pythonDebugHelper from './python/PythonDebugHelper';

export interface DockerDebugContext { // Same as DockerTaskContext but intentionally does not extend it, since we never need to pass a DockerDebugContext to tasks
    folder: WorkspaceFolder;
    platform: DockerPlatform;
    actionContext: IActionContext;
    cancellationToken?: CancellationToken;
    runDefinition?: DockerRunTaskDefinition;
}

// tslint:disable-next-line: no-empty-interface
export interface DockerDebugScaffoldContext extends DockerTaskScaffoldContext {
}

export interface ResolvedDebugConfigurationOptions {
    containerNameToKill?: string;
    dockerServerReadyAction?: DockerServerReadyAction;
    removeContainerAfterDebug?: boolean;
}

export interface ResolvedDebugConfiguration extends DebugConfiguration {
    dockerOptions?: ResolvedDebugConfigurationOptions;
}

export interface DebugHelper {
    provideDebugConfigurations(context: DockerDebugScaffoldContext): Promise<DockerDebugConfiguration[]>;
    resolveDebugConfiguration(context: DockerDebugContext, debugConfiguration: DockerDebugConfiguration): Promise<ResolvedDebugConfiguration | undefined>;
}

export function registerDebugProvider(ctx: ExtensionContext): void {
    ctx.subscriptions.push(
        debug.registerDebugConfigurationProvider(
            'docker',
            new DockerDebugConfigurationProvider(
                new CliDockerClient(new ChildProcessProvider()),
                {
                    netCore: netCoreDebugHelper,
                    node: nodeDebugHelper,
                    python: pythonDebugHelper,
                }
            )
        )
    );

    registerServerReadyAction(ctx);

    registerCommand('vscode-docker.debugging.initializeForDebugging', initializeForDebugging);
}

// TODO: This is stripping out a level of indentation, but the tasks one isn't
export async function addDebugConfiguration(debugConfiguration: DockerDebugConfiguration): Promise<boolean> {
    // Using config API instead of tasks API means no wasted perf on re-resolving the tasks, and avoids confusion on resolved type !== true type
    const workspaceLaunch = workspace.getConfiguration('launch');
    const allConfigs = workspaceLaunch && workspaceLaunch.configurations as DebugConfiguration[] || [];

    if (allConfigs.some(c => c.name === debugConfiguration.name)) {
        return false;
    }

    allConfigs.push(debugConfiguration);
    await workspaceLaunch.update('configurations', allConfigs);
    return true;
}

export function inferContainerName(debugConfiguration: DockerDebugConfiguration, context: DockerDebugContext, defaultContainerName: string): string {
    return (debugConfiguration && debugConfiguration.containerName)
        || (context && context.runDefinition && context.runDefinition.dockerRun && context.runDefinition.dockerRun.containerName)
        || defaultContainerName;
}
