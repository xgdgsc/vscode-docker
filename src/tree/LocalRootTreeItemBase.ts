/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigurationChangeEvent, ConfigurationTarget, TreeView, TreeViewVisibilityChangeEvent, workspace, WorkspaceConfiguration } from "vscode";
import { AzExtParentTreeItem, AzExtTreeItem, AzureWizard, GenericTreeItem, IActionContext, InvalidTreeItem, registerEvent } from "vscode-azureextensionui";
import { configPrefix } from "../constants";
import { ext } from "../extensionVariables";
import { DockerExtensionKind, getVSCodeRemoteInfo, IVSCodeRemoteInfo, RemoteKind } from "../utils/getVSCodeRemoteInfo";
import { getThemedIconPath } from "./IconPath";
import { LocalGroupTreeItemBase } from "./LocalGroupTreeItemBase";
import { OpenUrlTreeItem } from "./OpenUrlTreeItem";
import { CommonGroupBy, CommonProperty, CommonSortBy, sortByProperties } from "./settings/CommonProperties";
import { ITreeArraySettingInfo, ITreeSettingInfo } from "./settings/ITreeSettingInfo";
import { ITreeSettingsWizardContext, ITreeSettingWizardInfo } from "./settings/ITreeSettingsWizardContext";
import { TreeSettingListStep } from "./settings/TreeSettingListStep";
import { TreeSettingStep } from "./settings/TreeSettingStep";

export interface ILocalItem {
    createdTime: number;
    treeId: string;
    data: {};
}

export type LocalChildType<T extends ILocalItem> = new (parent: AzExtParentTreeItem, item: T) => AzExtTreeItem & { createdTime: number; };
export type LocalChildGroupType<TItem extends ILocalItem, TProperty extends string | CommonProperty> = new (parent: LocalRootTreeItemBase<TItem, TProperty>, group: string, items: TItem[]) => LocalGroupTreeItemBase<TItem, TProperty>;

const groupByKey: string = 'groupBy';
const sortByKey: string = 'sortBy';
const labelKey: string = 'label';
const descriptionKey: string = 'description';

export abstract class LocalRootTreeItemBase<TItem extends ILocalItem, TProperty extends string | CommonProperty> extends AzExtParentTreeItem {
    public abstract labelSettingInfo: ITreeSettingInfo<TProperty>;
    public abstract descriptionSettingInfo: ITreeArraySettingInfo<TProperty>;
    public abstract groupBySettingInfo: ITreeSettingInfo<TProperty | CommonGroupBy>;
    public sortBySettingInfo: ITreeSettingInfo<CommonSortBy> = {
        properties: sortByProperties,
        defaultProperty: 'CreatedTime',
    }

    public abstract treePrefix: string;
    public abstract configureExplorerTitle: string;
    public abstract childType: LocalChildType<TItem>;
    public abstract childGroupType: LocalChildGroupType<TItem, TProperty>;

    public abstract getItems(): Promise<TItem[] | undefined>;
    public abstract getPropertyValue(item: TItem, property: TProperty): string;

    public groupBySetting: TProperty | CommonGroupBy;
    public sortBySetting: CommonSortBy;
    public labelSetting: TProperty;
    public descriptionSetting: TProperty[];

    private _currentItems: TItem[] | undefined;
    private _itemsFromPolling: TItem[] | undefined;
    private _failedToConnect: boolean = false;

    public get contextValue(): string {
        return this.treePrefix;
    }

    public get config(): WorkspaceConfiguration {
        return workspace.getConfiguration(`${configPrefix}.${this.treePrefix}`);
    }

    public registerRefreshEvents(treeView: TreeView<AzExtTreeItem>): void {
        let intervalId: NodeJS.Timeout;
        registerEvent('treeView.onDidChangeVisibility', treeView.onDidChangeVisibility, (context: IActionContext, e: TreeViewVisibilityChangeEvent) => {
            context.errorHandling.suppressDisplay = true;
            context.telemetry.suppressIfSuccessful = true;
            context.telemetry.properties.isActivationEvent = 'true';

            if (e.visible) {
                const configOptions: WorkspaceConfiguration = workspace.getConfiguration('docker');
                const refreshInterval: number = configOptions.get<number>('explorerRefreshInterval', 1000);
                intervalId = setInterval(
                    async () => {
                        if (await this.hasChanged()) {
                            await this.refresh();
                        }
                    },
                    refreshInterval);
            } else {
                clearInterval(intervalId);
            }
        });

        registerEvent('treeView.onDidChangeConfiguration', workspace.onDidChangeConfiguration, async (context: IActionContext, e: ConfigurationChangeEvent) => {
            context.errorHandling.suppressDisplay = true;
            context.telemetry.suppressIfSuccessful = true;
            context.telemetry.properties.isActivationEvent = 'true';

            if (e.affectsConfiguration(`${configPrefix}.${this.treePrefix}`)) {
                await this.refresh();
            }
        });
    }

    public async loadMoreChildrenImpl(_clearCache: boolean, context: IActionContext): Promise<AzExtTreeItem[]> {
        try {
            this._currentItems = this._itemsFromPolling || await this.getSortedItems();
            this._itemsFromPolling = undefined;
            this._failedToConnect = false;
        } catch (error) {
            this._currentItems = undefined;
            this._failedToConnect = true;
            context.telemetry.properties.failedToConnect = 'true';
            return this.getDockerErrorTreeItems(context, error);
        }

        if (this._currentItems.length === 0) {
            context.telemetry.properties.noItems = 'true';
            return [new GenericTreeItem(this, {
                label: "Successfully connected, but no items found.",
                iconPath: getThemedIconPath('info'),
                contextValue: 'dockerNoItems'
            })];
        } else {
            this.groupBySetting = this.getTreeSetting(groupByKey, this.groupBySettingInfo);
            context.telemetry.properties.groupBySetting = this.groupBySetting;
            this.sortBySetting = this.getTreeSetting(sortByKey, this.sortBySettingInfo);
            context.telemetry.properties.sortBySetting = this.sortBySetting;
            this.labelSetting = this.getTreeSetting(labelKey, this.labelSettingInfo);
            context.telemetry.properties.labelSetting = this.labelSetting;
            this.descriptionSetting = this.getTreeArraySetting(descriptionKey, this.descriptionSettingInfo);
            context.telemetry.properties.descriptionSetting = this.descriptionSetting.toString();

            return this.groupItems(this._currentItems);
        }
    }

    public hasMoreChildrenImpl(): boolean {
        return false;
    }

    public compareChildrenImpl(ti1: AzExtTreeItem, ti2: AzExtTreeItem): number {
        if (this._failedToConnect) {
            return 0; // children are already sorted
        } else {
            if (ti1 instanceof this.childGroupType && ti2 instanceof this.childGroupType) {
                if (this.groupBySetting === 'CreatedTime' && ti2.maxCreatedTime !== ti1.maxCreatedTime) {
                    return ti2.maxCreatedTime - ti1.maxCreatedTime;
                }
            } else if (ti1 instanceof this.childType && ti2 instanceof this.childType) {
                if (this.sortBySetting === 'CreatedTime' && ti2.createdTime !== ti1.createdTime) {
                    return ti2.createdTime - ti1.createdTime;
                }
            }

            return super.compareChildrenImpl(ti1, ti2);
        }
    }

    private async groupItems(items: TItem[]): Promise<AzExtTreeItem[]> {
        let itemsWithNoGroup: TItem[] = [];
        const groupMap = new Map<string, TItem[]>();

        if (this.groupBySetting === 'None') {
            itemsWithNoGroup = items;
        } else {
            for (const item of items) {
                const groupName: string | undefined = this.getPropertyValue(item, this.groupBySetting);
                if (!groupName) {
                    itemsWithNoGroup.push(item);
                } else {
                    const groupedItems = groupMap.get(groupName);
                    if (groupedItems) {
                        groupedItems.push(item);
                    } else {
                        groupMap.set(groupName, [item]);
                    }
                }
            }
        }

        return await this.createTreeItemsWithErrorHandling(
            [...itemsWithNoGroup, ...groupMap.entries()],
            'invalidLocalItemOrGroup',
            itemOrGroup => {
                if (Array.isArray(itemOrGroup)) {
                    const [groupName, groupedItems] = itemOrGroup;
                    return new this.childGroupType(this, groupName, groupedItems);
                } else {
                    return new this.childType(this, itemOrGroup);
                }
            },
            itemOrGroup => {
                if (Array.isArray(itemOrGroup)) {
                    const [group] = itemOrGroup;
                    return group;
                } else {
                    return itemOrGroup.treeId;
                }
            }
        );
    }

    public getTreeItemLabel(item: TItem): string {
        return this.getPropertyValue(item, this.labelSetting);
    }

    public getTreeItemDescription(item: TItem): string {
        const values: string[] = this.descriptionSetting.map(prop => this.getPropertyValue(item, prop));
        return values.join(' - ');
    }

    public getTreeSetting<T extends string>(setting: string, settingInfo: ITreeSettingInfo<T>): T {
        const value = this.config.get<T>(setting);
        if (value && settingInfo.properties.find(propInfo => propInfo.property === value)) {
            return value;
        } else {
            return settingInfo.defaultProperty;
        }
    }

    public getTreeArraySetting<T extends string>(setting: string, settingInfo: ITreeArraySettingInfo<T>): T[] {
        const value = this.config.get<T[]>(setting);
        if (Array.isArray(value) && value.every(v1 => !!settingInfo.properties.find(v2 => v1 === v2.property))) {
            return value;
        } else {
            return settingInfo.defaultProperty;
        }
    }

    public getSettingWizardInfoList(): ITreeSettingWizardInfo[] {
        return [
            {
                label: 'Label',
                setting: labelKey,
                currentValue: this.labelSetting,
                description: 'The primary property to display.',
                settingInfo: this.labelSettingInfo
            },
            {
                label: 'Description',
                setting: descriptionKey,
                currentValue: this.descriptionSetting,
                description: 'Any secondary properties to display.',
                settingInfo: this.descriptionSettingInfo
            },
            {
                label: 'Group By',
                setting: groupByKey,
                currentValue: this.groupBySetting,
                description: 'The property used for grouping.',
                settingInfo: this.groupBySettingInfo
            },
            {
                label: 'Sort By',
                setting: sortByKey,
                currentValue: this.sortBySetting,
                description: 'The property used for sorting.',
                settingInfo: this.sortBySettingInfo
            },
        ]
    }

    public async configureExplorer(context: IActionContext): Promise<void> {
        const infoList = this.getSettingWizardInfoList();
        const wizardContext: ITreeSettingsWizardContext = { infoList, ...context };
        const wizard = new AzureWizard(wizardContext, {
            title: this.configureExplorerTitle,
            promptSteps: [
                new TreeSettingListStep(),
                new TreeSettingStep()
            ],
            hideStepCount: true
        });
        await wizard.prompt();
        await wizard.execute();

        if (wizardContext.info) {
            this.config.update(wizardContext.info.setting, wizardContext.newValue, ConfigurationTarget.Global);
        } else {
            // reset settings
            for (const info of infoList) {
                this.config.update(info.setting, undefined, ConfigurationTarget.Global);
            }
        }
    }

    private getDockerErrorTreeItems(context: IActionContext, error: unknown): AzExtTreeItem[] {
        const connectionMessage = 'Failed to connect. Is Docker installed and running?';

        const result: AzExtTreeItem[] = [
            new InvalidTreeItem(this, error, { label: connectionMessage, contextValue: 'dockerConnectionError', description: '' }),
            new OpenUrlTreeItem(this, 'Install Docker...', 'https://aka.ms/AA37qtj'),
            new OpenUrlTreeItem(this, 'Additional Troubleshooting...', 'https://aka.ms/AA37qt2'),
        ];

        const remoteInfo: IVSCodeRemoteInfo = getVSCodeRemoteInfo(context);
        if (remoteInfo.extensionKind === DockerExtensionKind.workspace && remoteInfo.remoteKind === RemoteKind.devContainer) {
            const ti = new OpenUrlTreeItem(this, 'Running Docker in a dev container...', 'https://aka.ms/AA5xva6');
            result.push(ti);
        }

        return result;
    }

    private async getSortedItems(): Promise<TItem[]> {
        if (ext.dockerodeInitError === undefined) {
            const items: TItem[] = await this.getItems() || [];
            return items.sort((a, b) => a.treeId.localeCompare(b.treeId));
        } else {
            throw ext.dockerodeInitError;
        }
    }

    private async hasChanged(): Promise<boolean> {
        try {
            this._itemsFromPolling = await this.getSortedItems();
        } catch {
            this._itemsFromPolling = undefined;
        }

        return !this.areArraysEqual(this._currentItems, this._itemsFromPolling);
    }

    private areArraysEqual(array1: TItem[] | undefined, array2: TItem[] | undefined): boolean {
        if (array1 === array2) {
            return true;
        } else if (array1 && array2) {
            if (array1.length !== array2.length) {
                return false;
            } else {
                return !array1.some((item1, index) => {
                    return item1.treeId !== array2[index].treeId;
                });
            }
        } else {
            return false;
        }
    }
}
