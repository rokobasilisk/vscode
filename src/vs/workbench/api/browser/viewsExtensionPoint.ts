/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { localize } from 'vs/nls';
import { forEach } from 'vs/base/common/collections';
import { IJSONSchema } from 'vs/base/common/jsonSchema';
import { ExtensionMessageCollector, ExtensionsRegistry, IExtensionPoint } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { ViewLocation, ViewsRegistry, ICustomViewDescriptor } from 'vs/workbench/common/views';
import { CustomTreeViewPanel, CustomTreeViewer } from 'vs/workbench/browser/parts/views/customView';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { coalesce, } from 'vs/base/common/arrays';
import { viewsContainersExtensionPoint } from 'vs/workbench/api/browser/viewsContainersExtensionPoint';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { Registry } from 'vs/platform/registry/common/platform';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ProgressLocation } from 'vs/platform/progress/common/progress';

interface IUserFriendlyViewDescriptor {
	id: string;
	name: string;
	when?: string;
}

const viewDescriptor: IJSONSchema = {
	type: 'object',
	properties: {
		id: {
			description: localize('vscode.extension.contributes.view.id', 'Identifier of the view. Use this to register a data provider through `vscode.window.registerTreeDataProviderForView` API. Also to trigger activating your extension by registering `onView:${id}` event to `activationEvents`.'),
			type: 'string'
		},
		name: {
			description: localize('vscode.extension.contributes.view.name', 'The human-readable name of the view. Will be shown'),
			type: 'string'
		},
		when: {
			description: localize('vscode.extension.contributes.view.when', 'Condition which must be true to show this view'),
			type: 'string'
		},
	}
};

const viewsContribution: IJSONSchema = {
	description: localize('vscode.extension.contributes.views', "Contributes views to the editor"),
	type: 'object',
	properties: {
		'explorer': {
			description: localize('views.explorer', "Contributes views to Explorer container in the Activity bar"),
			type: 'array',
			items: viewDescriptor,
			default: []
		},
		'debug': {
			description: localize('views.debug', "Contributes views to Debug container in the Activity bar"),
			type: 'array',
			items: viewDescriptor,
			default: []
		},
		'scm': {
			description: localize('views.scm', "Contributes views to SCM container in the Activity bar"),
			type: 'array',
			items: viewDescriptor,
			default: []
		},
		'test': {
			description: localize('views.test', "Contributes views to Test container in the Activity bar"),
			type: 'array',
			items: viewDescriptor,
			default: []
		}
	},
	additionalProperties: {
		description: localize('views.contributed', "Contributes views to contributed views container"),
		type: 'array',
		items: viewDescriptor,
		default: []
	}
};


const viewsExtensionPoint: IExtensionPoint<{ [loc: string]: IUserFriendlyViewDescriptor[] }> = ExtensionsRegistry.registerExtensionPoint<{ [loc: string]: IUserFriendlyViewDescriptor[] }>('views', [viewsContainersExtensionPoint], viewsContribution);

class ViewsContainersExtensionHandler implements IWorkbenchContribution {
	constructor(
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		this.handleAndRegisterCustomViews();
	}

	private handleAndRegisterCustomViews() {
		viewsExtensionPoint.setHandler(extensions => {
			for (let extension of extensions) {
				const { value, collector } = extension;

				forEach(value, entry => {
					if (!this.isValidViewDescriptors(entry.value, collector)) {
						return;
					}

					let location = this.getViewLocation(entry.key);
					if (!location) {
						collector.warn(localize('ViewContainerDoesnotExist', "View container '{0}' does not exist and all views registered to it will be added to 'Explorer'.", entry.key));
						location = ViewLocation.Explorer;
					}
					const registeredViews = ViewsRegistry.getViews(location);
					const viewIds = [];
					const viewDescriptors = coalesce(entry.value.map(item => {
						// validate
						if (viewIds.indexOf(item.id) !== -1) {
							collector.error(localize('duplicateView1', "Cannot register multiple views with same id `{0}` in the location `{1}`", item.id, location.id));
							return null;
						}
						if (registeredViews.some(v => v.id === item.id)) {
							collector.error(localize('duplicateView2', "A view with id `{0}` is already registered in the location `{1}`", item.id, location.id));
							return null;
						}

						const viewDescriptor = <ICustomViewDescriptor>{
							id: item.id,
							name: item.name,
							ctor: CustomTreeViewPanel,
							location,
							when: ContextKeyExpr.deserialize(item.when),
							canToggleVisibility: true,
							collapsed: this.showCollapsed(location),
							treeViewer: this.instantiationService.createInstance(CustomTreeViewer, item.id, this.getProgressLocation(location))
						};

						viewIds.push(viewDescriptor.id);
						return viewDescriptor;
					}));
					ViewsRegistry.registerViews(viewDescriptors);
				});
			}
		});
	}

	private getProgressLocation(location: ViewLocation): ProgressLocation {
		switch (location.id) {
			case ViewLocation.Explorer.id:
				return ProgressLocation.Explorer;
			case ViewLocation.SCM.id:
				return ProgressLocation.Scm;
			case ViewLocation.Debug.id:
				return null /* No debug progress location yet */;
		}
		return null;
	}

	private isValidViewDescriptors(viewDescriptors: IUserFriendlyViewDescriptor[], collector: ExtensionMessageCollector): boolean {
		if (!Array.isArray(viewDescriptors)) {
			collector.error(localize('requirearray', "views must be an array"));
			return false;
		}

		for (let descriptor of viewDescriptors) {
			if (typeof descriptor.id !== 'string') {
				collector.error(localize('requirestring', "property `{0}` is mandatory and must be of type `string`", 'id'));
				return false;
			}
			if (typeof descriptor.name !== 'string') {
				collector.error(localize('requirestring', "property `{0}` is mandatory and must be of type `string`", 'name'));
				return false;
			}
			if (descriptor.when && typeof descriptor.when !== 'string') {
				collector.error(localize('optstring', "property `{0}` can be omitted or must be of type `string`", 'when'));
				return false;
			}
		}

		return true;
	}


	private getViewLocation(value: string): ViewLocation {
		switch (value) {
			case 'explorer': return ViewLocation.Explorer;
			case 'debug': return ViewLocation.Debug;
			case 'scm': return ViewLocation.SCM;
			default: return ViewLocation.get(`workbench.view.extension.${value}`);
		}
	}

	private showCollapsed(location: ViewLocation): boolean {
		switch (location) {
			case ViewLocation.Explorer:
			case ViewLocation.SCM:
			case ViewLocation.Debug:
				return true;
		}
		return false;
	}
}

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(ViewsContainersExtensionHandler, LifecyclePhase.Starting);