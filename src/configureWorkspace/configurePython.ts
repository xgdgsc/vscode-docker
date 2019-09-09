/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkspaceFolder } from 'vscode';
import { IActionContext } from 'vscode-azureextensionui';
import { DockerDebugScaffoldContext } from '../debugging/DebugHelper';
import dockerDebugScaffoldingProvider from '../debugging/DockerDebugScaffoldingProvider';
import { PlatformOS } from '../utils/platform';
import { getComposePorts, getExposeStatements, IPlatformGeneratorInfo, PackageInfo } from './configure';

export let configurePython: IPlatformGeneratorInfo = {
    genDockerFile,
    genDockerCompose,
    genDockerComposeDebug,
    defaultPorts: [3000],
    initializeForDebugging: initializeForDebugging,
};

function genDockerFile(serviceNameAndRelativePath: string, platform: string, os: string | undefined, ports: number[], { cmd, author, version, artifactName }: Partial<PackageInfo>): string {
    let exposeStatements = getExposeStatements(ports);

    return `# Python support can be specified down to the minor or micro version
# (e.g. 3.6 or 3.6.3).
# OS Support also exists for jessie & stretch (slim and full).
# See https://hub.docker.com/r/library/python/ for all supported Python
# tags from Docker Hub.
FROM python:alpine

# If you prefer miniconda:
#FROM continuumio/miniconda3

LABEL Name=${serviceNameAndRelativePath} Version=${version}
${exposeStatements}

WORKDIR /app
ADD . /app

# Using pip:
RUN python3 -m pip install -r requirements.txt
CMD ["python3", "-m", "${serviceNameAndRelativePath}"]

# Using pipenv:
#RUN python3 -m pip install pipenv
#RUN pipenv install --ignore-pipfile
#CMD ["pipenv", "run", "python3", "-m", "${serviceNameAndRelativePath}"]

# Using miniconda (make sure to replace 'myenv' w/ your environment name):
#RUN conda env create -f environment.yml
#CMD /bin/bash -c "source activate myenv && python3 -m ${serviceNameAndRelativePath}"
`;
}

function genDockerCompose(serviceNameAndRelativePath: string, platform: string, os: string | undefined, ports: number[]): string {
    return `version: '2.1'

services:
    ${serviceNameAndRelativePath}:
        image: ${serviceNameAndRelativePath}
        build: .
${getComposePorts(ports)}`;
}

function genDockerComposeDebug(serviceNameAndRelativePath: string, platform: string, os: string | undefined, ports: number[], { fullCommand: cmd }: Partial<PackageInfo>): string {
    return `version: '2.1'

services:
    ${serviceNameAndRelativePath}:
        image: ${serviceNameAndRelativePath}
        build:
            context: .
            dockerfile: Dockerfile
${getComposePorts(ports)}`;
}

async function initializeForDebugging(context: IActionContext, folder: WorkspaceFolder, platformOS: PlatformOS, packageInfo: PackageInfo): Promise<void> {
    const scaffoldContext: DockerDebugScaffoldContext = {
        folder: folder,
        platform: 'node',
        actionContext: context,
    }

    await dockerDebugScaffoldingProvider.initializeNodeForDebugging(scaffoldContext);
}
