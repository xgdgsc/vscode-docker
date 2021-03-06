/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window } from 'vscode';
import { IActionContext } from 'vscode-azureextensionui';
import { ext } from '../../extensionVariables';
import { convertToMB } from '../../utils/convertToMB';

export async function pruneVolumes(_context: IActionContext): Promise<void> {
    const confirmPrune: string = "Are you sure you want to remove all unused volumes?";
    // no need to check result - cancel will throw a UserCancelledError
    await ext.ui.showWarningMessage(confirmPrune, { modal: true }, { title: 'Remove' });

    const result = await ext.dockerode.pruneVolumes();

    const numDeleted = (result.VolumesDeleted || []).length;
    const mbReclaimed = convertToMB(result.SpaceReclaimed);
    let message = `Removed ${numDeleted} volumes(s) and reclaimed ${mbReclaimed}MB of space.`;
    // don't wait
    window.showInformationMessage(message);
}
