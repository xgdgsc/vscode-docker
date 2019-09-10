/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, debug, DebugConfiguration, DebugConfigurationProvider, ProviderResult, WorkspaceFolder } from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext } from 'vscode-azureextensionui';
import { getAssociatedDockerRunTask } from '../tasks/TaskHelper';
import { quickPickWorkspaceFolder } from '../utils/quickPickWorkspaceFolder';
import { DockerClient } from './coreclr/CliDockerClient';
import { DebugHelper, DockerDebugContext, ResolvedDebugConfiguration } from './DebugHelper';
import { DockerPlatform, getPlatform } from './DockerPlatformHelper';
import { NetCoreDockerDebugConfiguration } from './netcore/NetCoreDebugHelper';
import { NodeDockerDebugConfiguration } from './node/NodeDebugHelper';
import { PythonDockerDebugConfiguration } from './python/PythonDebugHelper';

export interface DockerDebugConfiguration extends NetCoreDockerDebugConfiguration, NodeDockerDebugConfiguration, PythonDockerDebugConfiguration {
    platform?: DockerPlatform;
}

export class DockerDebugConfigurationProvider implements DebugConfigurationProvider {
    constructor(
        private readonly dockerClient: DockerClient,
        private readonly helpers: { [key in DockerPlatform]: DebugHelper }
    ) { }

    public provideDebugConfigurations(folder: WorkspaceFolder | undefined, token?: CancellationToken): ProviderResult<DebugConfiguration[]> {
        return undefined;
    }

    public resolveDebugConfiguration(folder: WorkspaceFolder | undefined, debugConfiguration: DockerDebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration | undefined> {
        const debugPlatform = getPlatform(debugConfiguration);
        return callWithTelemetryAndErrorHandling(
            `docker-launch/${debugPlatform || 'unknown'}`,
            async (actionContext: IActionContext) => await this.resolveDebugConfigurationInternal(
                {
                    folder: folder || await quickPickWorkspaceFolder('To debug with Docker you must first open a folder or workspace in VS Code.'),
                    platform: debugPlatform,
                    actionContext: actionContext,
                    cancellationToken: token,
                },
                debugConfiguration));
    }

    private async resolveDebugConfigurationInternal(context: DockerDebugContext, originalConfiguration: DockerDebugConfiguration): Promise<DockerDebugConfiguration | undefined> {
        context.actionContext.telemetry.properties.platform = context.platform;

        context.runDefinition = await getAssociatedDockerRunTask(originalConfiguration);

        const helper = this.getHelper(context.platform);
        const resolvedConfiguration = await helper.resolveDebugConfiguration(context, originalConfiguration);

        if (resolvedConfiguration) {
            await this.validateResolvedConfiguration(resolvedConfiguration);
            await this.registerRemoveContainerAfterDebugging(resolvedConfiguration);
        }

        // TODO: addDockerSettingsToEnv?
        return resolvedConfiguration;
    }

    private async validateResolvedConfiguration(resolvedConfiguration: ResolvedDebugConfiguration): Promise<void> {
        if (!resolvedConfiguration.type) {
            throw new Error('No debug type was resolved.');
        } else if (!resolvedConfiguration.request) {
            throw new Error('No debug request was resolved.');
        }
    }

    private async registerRemoveContainerAfterDebugging(resolvedConfiguration: ResolvedDebugConfiguration): Promise<void> {
        if (resolvedConfiguration.dockerOptions
            && (resolvedConfiguration.dockerOptions.removeContainerAfterDebug === undefined || resolvedConfiguration.dockerOptions.removeContainerAfterDebug)
            && resolvedConfiguration.dockerOptions.containerNameToKill) {
            try {
                await this.dockerClient.removeContainer(resolvedConfiguration.dockerOptions.containerNameToKill, { force: true });
            } catch { }

            // Now register the container for removal after the debug session ends
            const disposable = debug.onDidTerminateDebugSession(async session => {
                const sessionConfiguration = <ResolvedDebugConfiguration>session.configuration;

                try {
                    if (sessionConfiguration
                        && sessionConfiguration.dockerOptions
                        && sessionConfiguration.dockerOptions.containerNameToKill === resolvedConfiguration.dockerOptions.containerNameToKill) {
                        await this.dockerClient.removeContainer(resolvedConfiguration.dockerOptions.containerNameToKill, { force: true });
                        disposable.dispose();
                    } else {
                        return; // Return without disposing--this isn't our debug session
                    }
                } catch {
                    disposable.dispose();
                }
            });
        }
    }

    private getHelper(platform: DockerPlatform): DebugHelper {
        const helper = this.helpers[platform];

        if (!helper) {
            throw new Error(`The platform '${platform}' is not currently supported for Docker debugging.`);
        }

        return helper;
    }
}
