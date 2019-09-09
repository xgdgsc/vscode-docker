/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DebugHelper, DockerDebugContext, DockerDebugScaffoldContext, ResolvedDebugConfiguration } from '../DebugHelper';
import { DockerDebugConfigurationBase } from '../DockerDebugConfigurationBase';
import { DockerDebugConfiguration } from '../DockerDebugConfigurationProvider';

export interface PythonPathMapping {
    localRoot: string,
    remoteRoot: string,
}

export interface PythonDebugOptions {
    pathMappings?: PythonPathMapping[],
    justMyCode?: boolean,
}

export interface PythonDockerDebugConfiguration extends DockerDebugConfigurationBase {
    python?: PythonDebugOptions;
}

export class PythonDebugHelper implements DebugHelper {
    public async provideDebugConfigurations(context: DockerDebugScaffoldContext): Promise<DockerDebugConfiguration[]> {
        // tslint:disable: no-invalid-template-strings
        return [
            {
                name: 'Docker Python Launch and Attach',
                type: 'docker',
                request: 'launch',
                preLaunchTask: 'docker-run: debug',
                platform: 'python',
                python: {
                    pathMappings: [
                        {
                            localRoot: '${workspaceFolder}',
                            remoteRoot: '/app'
                        }
                    ]
                },
            }
        ];
        // tslint:enable: no-invalid-template-strings
    }

    public async resolveDebugConfiguration(context: DockerDebugContext, debugConfiguration: PythonDockerDebugConfiguration): Promise<ResolvedDebugConfiguration | undefined> {
        //const options = debugConfiguration.python || {};

        return {
            name: debugConfiguration.name,
            type: 'python',
            request: 'attach',
            host: debugConfiguration.host || 'localhost',
            port: debugConfiguration.port || 5678,
            pathMappings: debugConfiguration.python.pathMappings,
            justMyCode: debugConfiguration.python.justMyCode,

            launchBrowser: debugConfiguration.launchBrowser,
            serverReadyAction: debugConfiguration.serverReadyAction,
            dockerOptions: {
                containerNameToKill: containerName,
                dockerServerReadyAction: dockerServerReadyAction,
                removeContainerAfterDebug: debugConfiguration.removeContainerAfterDebug
            },
            preLaunchTask: debugConfiguration.preLaunchTask,
        };
    }
}

const pythonDebugHelper = new PythonDebugHelper();

export default pythonDebugHelper;
