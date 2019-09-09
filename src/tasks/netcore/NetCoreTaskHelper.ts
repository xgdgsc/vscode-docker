/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { WorkspaceFolder } from 'vscode';
import { LocalAspNetCoreSslManager } from '../../debugging/coreclr/LocalAspNetCoreSslManager';
import { NetCoreDebugHelper, NetCoreDebugOptions } from '../../debugging/netcore/NetCoreDebugHelper';
import { PlatformOS } from '../../utils/platform';
import { quickPickProjectFileItem } from '../../utils/quick-pick-file';
import { resolveFilePath, unresolveFilePath } from '../../utils/resolveFilePath';
import { DockerBuildOptions, DockerBuildTaskDefinitionBase } from '../DockerBuildTaskDefinitionBase';
import { DockerBuildTaskDefinition } from '../DockerBuildTaskProvider';
import { DockerContainerVolume, DockerRunOptions, DockerRunTaskDefinitionBase } from '../DockerRunTaskDefinitionBase';
import { DockerRunTaskDefinition } from '../DockerRunTaskProvider';
import { addVolumeWithoutConflicts, DockerBuildTaskContext, DockerRunTaskContext, DockerTaskScaffoldContext, getDefaultContainerName, getDefaultImageName, inferImageName, TaskHelper } from '../TaskHelper';

export interface NetCoreTaskOptions {
    appProject?: string;
    configureSsl?: boolean;
}

export interface NetCoreBuildTaskDefinition extends DockerBuildTaskDefinitionBase {
    netCore?: NetCoreTaskOptions;
}

export interface NetCoreRunTaskDefinition extends DockerRunTaskDefinitionBase {
    netCore?: NetCoreTaskOptions;
}

export interface NetCoreTaskScaffoldingOptions {
    appProject?: string;
    platformOS?: PlatformOS;
}

const UserSecretsRegex = /UserSecretsId/i;
const MacNuGetPackageFallbackFolderPath = '/usr/local/share/dotnet/sdk/NuGetFallbackFolder';
const LinuxNuGetPackageFallbackFolderPath = '/usr/share/dotnet/sdk/NuGetFallbackFolder';

export class NetCoreTaskHelper implements TaskHelper {
    private static readonly defaultLabels: { [key: string]: string } = { 'com.microsoft.created-by': 'visual-studio-code' };

    public async provideDockerBuildTasks(context: DockerTaskScaffoldContext, options?: NetCoreTaskScaffoldingOptions): Promise<DockerBuildTaskDefinition[]> {
        options = options || {};
        options.appProject = options.appProject || await NetCoreTaskHelper.inferAppProject(context.folder); // This method internally checks the user-defined input first

        return [
            {
                type: 'docker-build',
                label: 'docker-build: debug',
                dependsOn: ['build'],
                dockerBuild: {
                    tag: getDefaultImageName(context.folder.name, 'dev'),
                    target: 'base',
                },
                netCore: {
                    appProject: unresolveFilePath(options.appProject, context.folder)
                }
            },
            {
                type: 'docker-build',
                label: 'docker-build: release',
                dependsOn: ['build'],
                dockerBuild: {
                    tag: getDefaultImageName(context.folder.name, 'latest'), // The 'latest' here is redundant but added to differentiate from above's 'dev'
                },
                netCore: {
                    appProject: unresolveFilePath(options.appProject, context.folder)
                }
            }
        ];
    }

    public async provideDockerRunTasks(context: DockerTaskScaffoldContext, options?: NetCoreTaskScaffoldingOptions): Promise<DockerRunTaskDefinition[]> {
        options = options || {};
        options.appProject = options.appProject || await NetCoreTaskHelper.inferAppProject(context.folder); // This method internally checks the user-defined input first
        options.platformOS = options.platformOS || 'Linux';

        return [
            {
                type: 'docker-run',
                label: 'docker-run: debug',
                dependsOn: ['docker-build: debug'],
                dockerRun: {
                    entrypoint: options.platformOS === 'Windows' ? 'ping' : 'tail',
                    command: options.platformOS === 'Windows' ? '-t localhost' : '-f /dev/null',
                    os: options.platformOS === 'Windows' ? 'Windows' : undefined, // Default is Linux so we'll leave it undefined for brevity
                },
                netCore: {
                    appProject: unresolveFilePath(options.appProject, context.folder)
                }
            }
        ];
    }

    public async resolveDockerBuildOptions(context: DockerBuildTaskContext, buildDefinition: NetCoreBuildTaskDefinition): Promise<DockerBuildOptions> {
        const buildOptions = buildDefinition.dockerBuild;

        // tslint:disable: no-invalid-template-strings
        buildOptions.context = buildOptions.context || '${workspaceFolder}';
        buildOptions.dockerfile = buildOptions.dockerfile || '${workspaceFolder}/Dockerfile';
        // tslint:enable: no-invalid-template-strings
        buildOptions.tag = buildOptions.tag || getDefaultImageName(context.folder.name);
        buildOptions.labels = buildOptions.labels || NetCoreTaskHelper.defaultLabels;

        return buildOptions;
    }

    public async resolveDockerRunOptions(context: DockerRunTaskContext, runDefinition: NetCoreRunTaskDefinition): Promise<DockerRunOptions> {
        const runOptions = runDefinition.dockerRun;
        const helperOptions = runDefinition.netCore || {};

        helperOptions.appProject = await NetCoreTaskHelper.inferAppProject(context.folder, helperOptions); // This method internally checks the user-defined input first

        runOptions.containerName = runOptions.containerName || getDefaultContainerName(context.folder.name);
        runOptions.labels = runOptions.labels || NetCoreTaskHelper.defaultLabels;
        runOptions.os = runOptions.os || 'Linux';
        runOptions.image = inferImageName(runDefinition, context, context.folder.name, 'dev');

        const ssl = helperOptions.configureSsl !== undefined ? helperOptions.configureSsl : await NetCoreTaskHelper.inferSsl(context.folder, helperOptions);
        const userSecrets = ssl === true ? true : await this.inferUserSecrets(helperOptions);

        if (userSecrets) {
            runOptions.env = runOptions.env || {};
            runOptions.env.ASPNETCORE_ENVIRONMENT = runOptions.env.ASPNETCORE_ENVIRONMENT || 'Development';

            if (ssl) {
                // tslint:disable-next-line: no-http-string
                runOptions.env.ASPNETCORE_URLS = runOptions.env.ASPNETCORE_URLS || 'https://+:443;http://+:80';
            }
        }

        runOptions.volumes = await this.inferVolumes(context.folder, runOptions, helperOptions, ssl, userSecrets); // Volumes specifically are unioned with the user input (their input does not override except where the container path is the same)

        return runOptions;
    }

    public static async inferAppFolder(folder: WorkspaceFolder, helperOptions: NetCoreTaskOptions | NetCoreDebugOptions): Promise<string> {
        if (helperOptions.appProject) {
            return path.dirname(helperOptions.appProject);
        }

        return folder.uri.fsPath;
    }

    public static async inferAppProject(folder: WorkspaceFolder, helperOptions?: NetCoreTaskOptions | NetCoreDebugOptions): Promise<string> {
        let result: string;

        if (helperOptions && helperOptions.appProject) {
            result = resolveFilePath(helperOptions.appProject, folder);
        } else {
            // Find a .csproj or .fsproj in the folder
            const item = await quickPickProjectFileItem(undefined, folder, 'No .NET Core project file (.csproj or .fsproj) could be found.');
            result = item.absoluteFilePath;
        }

        return result;
    }

    public static async inferSsl(folder: WorkspaceFolder, helperOptions: NetCoreTaskOptions): Promise<boolean> {
        try {
            const launchSettingsPath = path.join(path.dirname(helperOptions.appProject), 'Properties', 'launchSettings.json');

            if (await fse.pathExists(launchSettingsPath)) {
                const launchSettings = await fse.readJson(launchSettingsPath);

                //tslint:disable:no-unsafe-any no-any
                if (launchSettings && launchSettings.profiles) {
                    // launchSettings.profiles is a dictionary instead of an array, so need to get the values and look for one that has commandName: 'Project'
                    const projectProfile = Object.values<any>(launchSettings.profiles).find(p => p.commandName === 'Project');

                    if (projectProfile && projectProfile.applicationUrl && /https:\/\//i.test(projectProfile.applicationUrl)) {
                        return true;
                    }
                }
                //tslint:enable:no-unsafe-any no-any
            }
        } catch { }

        return false;
    }

    private async inferUserSecrets(helperOptions: NetCoreTaskOptions): Promise<boolean> {
        const contents = await fse.readFile(helperOptions.appProject);
        return UserSecretsRegex.test(contents.toString());
    }

    private async inferVolumes(folder: WorkspaceFolder, runOptions: DockerRunOptions, helperOptions: NetCoreTaskOptions, ssl: boolean, userSecrets: boolean): Promise<DockerContainerVolume[]> {
        const volumes: DockerContainerVolume[] = [];

        if (runOptions.volumes) {
            for (const volume of runOptions.volumes) {
                addVolumeWithoutConflicts(volumes, volume);
            }
        }

        const appVolume: DockerContainerVolume = {
            localPath: path.dirname(helperOptions.appProject),
            containerPath: runOptions.os === 'Windows' ? 'C:\\app' : '/app',
            permissions: 'rw'
        };

        const srcVolume: DockerContainerVolume = {
            localPath: folder.uri.fsPath,
            containerPath: runOptions.os === 'Windows' ? 'C:\\src' : '/src',
            permissions: 'rw'
        }

        const debuggerVolume: DockerContainerVolume = {
            localPath: NetCoreDebugHelper.getHostDebuggerPathBase(),
            containerPath: runOptions.os === 'Windows' ? 'C:\\remote_debugger' : '/remote_debugger',
            permissions: 'ro'
        };

        const nugetVolume: DockerContainerVolume = {
            localPath: path.join(os.homedir(), '.nuget', 'packages'),
            containerPath: runOptions.os === 'Windows' ? 'C:\\.nuget\\packages' : '/root/.nuget/packages',
            permissions: 'ro'
        };

        let programFilesEnvironmentVariable: string | undefined;

        if (os.platform() === 'win32') {
            programFilesEnvironmentVariable = process.env.ProgramFiles;

            if (programFilesEnvironmentVariable === undefined) {
                throw new Error('The environment variable \'ProgramFiles\' is not defined. This variable is used to locate the NuGet fallback folder.');
            }
        }

        const nugetFallbackVolume: DockerContainerVolume = {
            localPath: os.platform() === 'win32' ? path.join(programFilesEnvironmentVariable, 'dotnet', 'sdk', 'NuGetFallbackFolder') :
                (os.platform() === 'darwin' ? MacNuGetPackageFallbackFolderPath : LinuxNuGetPackageFallbackFolderPath),
            containerPath: runOptions.os === 'Windows' ? 'C:\\.nuget\\fallbackpackages' : '/root/.nuget/fallbackpackages',
            permissions: 'ro'
        };

        addVolumeWithoutConflicts(volumes, appVolume);
        addVolumeWithoutConflicts(volumes, srcVolume);
        addVolumeWithoutConflicts(volumes, debuggerVolume);
        addVolumeWithoutConflicts(volumes, nugetVolume);
        addVolumeWithoutConflicts(volumes, nugetFallbackVolume);

        if (userSecrets || ssl) {
            const hostSecretsFolders = LocalAspNetCoreSslManager.getHostSecretsFolders();
            const containerSecretsFolders = LocalAspNetCoreSslManager.getContainerSecretsFolders(runOptions.os);

            const userSecretsVolume: DockerContainerVolume = {
                localPath: hostSecretsFolders.userSecretsFolder,
                containerPath: containerSecretsFolders.userSecretsFolder,
                permissions: 'ro'
            };

            addVolumeWithoutConflicts(volumes, userSecretsVolume);

            if (ssl) {
                const certVolume: DockerContainerVolume = {
                    localPath: hostSecretsFolders.certificateFolder,
                    containerPath: containerSecretsFolders.certificateFolder,
                    permissions: 'ro'
                };

                addVolumeWithoutConflicts(volumes, certVolume);
            }
        }

        return volumes;
    }
}

const netCoreTaskHelper = new NetCoreTaskHelper();

export default netCoreTaskHelper;
