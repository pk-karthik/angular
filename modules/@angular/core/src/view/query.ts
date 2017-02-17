/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ElementRef} from '../linker/element_ref';
import {QueryList} from '../linker/query_list';
import {TemplateRef} from '../linker/template_ref';
import {ViewContainerRef} from '../linker/view_container_ref';

import {createTemplateRef, createViewContainerRef} from './refs';
import {NodeDef, NodeFlags, NodeType, QueryBindingDef, QueryBindingType, QueryDef, QueryValueType, Services, ViewData, asElementData, asProviderData, asQueryList} from './types';
import {declaredViewContainer, filterQueryId, isEmbeddedView, viewParentEl} from './util';

export function queryDef(
    flags: NodeFlags, id: number, bindings: {[propName: string]: QueryBindingType}): NodeDef {
  let bindingDefs: QueryBindingDef[] = [];
  for (let propName in bindings) {
    const bindingType = bindings[propName];
    bindingDefs.push({propName, bindingType});
  }

  return {
    type: NodeType.Query,
    // will bet set by the view definition
    index: undefined,
    reverseChildIndex: undefined,
    parent: undefined,
    renderParent: undefined,
    bindingIndex: undefined,
    disposableIndex: undefined,
    // regular values
    flags,
    childFlags: 0,
    childMatchedQueries: 0,
    ngContentIndex: undefined,
    matchedQueries: {},
    matchedQueryIds: 0,
    references: {},
    childCount: 0,
    bindings: [],
    disposableCount: 0,
    element: undefined,
    provider: undefined,
    text: undefined,
    pureExpression: undefined,
    query: {id, filterId: filterQueryId(id), bindings: bindingDefs},
    ngContent: undefined
  };
}

export function createQuery(): QueryList<any> {
  return new QueryList();
}

export function dirtyParentQueries(view: ViewData) {
  const queryIds = view.def.nodeMatchedQueries;
  while (view.parent && isEmbeddedView(view)) {
    let tplDef = view.parentNodeDef;
    view = view.parent;
    // content queries
    const end = tplDef.index + tplDef.childCount;
    for (let i = 0; i <= end; i++) {
      const nodeDef = view.def.nodes[i];
      if ((nodeDef.flags & NodeFlags.HasContentQuery) &&
          (nodeDef.flags & NodeFlags.HasDynamicQuery) &&
          (nodeDef.query.filterId & queryIds) === nodeDef.query.filterId) {
        asQueryList(view, i).setDirty();
      }
      if ((nodeDef.type === NodeType.Element && i + nodeDef.childCount < tplDef.index) ||
          !(nodeDef.childFlags & NodeFlags.HasContentQuery) ||
          !(nodeDef.childFlags & NodeFlags.HasDynamicQuery)) {
        // skip elements that don't contain the template element or no query.
        i += nodeDef.childCount;
      }
    }
  }

  // view queries
  let compDef = view.parentNodeDef;
  view = view.parent;
  if (view) {
    for (let i = compDef.index + 1; i <= compDef.index + compDef.childCount; i++) {
      const nodeDef = view.def.nodes[i];
      if ((nodeDef.flags & NodeFlags.HasViewQuery) && (nodeDef.flags & NodeFlags.HasDynamicQuery)) {
        asQueryList(view, i).setDirty();
      }
    }
  }
}

export function checkAndUpdateQuery(view: ViewData, nodeDef: NodeDef) {
  const queryList = asQueryList(view, nodeDef.index);
  if (!queryList.dirty) {
    return;
  }
  const providerDef = nodeDef.parent;
  const providerData = asProviderData(view, providerDef.index);
  let newValues: any[];
  if (nodeDef.flags & NodeFlags.HasContentQuery) {
    const elementDef = providerDef.parent;
    newValues = calcQueryValues(
        view, elementDef.index, elementDef.index + elementDef.childCount, nodeDef.query, []);
  } else if (nodeDef.flags & NodeFlags.HasViewQuery) {
    const compView = providerData.componentView;
    newValues = calcQueryValues(compView, 0, compView.def.nodes.length - 1, nodeDef.query, []);
  }
  queryList.reset(newValues);
  const bindings = nodeDef.query.bindings;
  let notify = false;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    let boundValue: any;
    switch (binding.bindingType) {
      case QueryBindingType.First:
        boundValue = queryList.first;
        break;
      case QueryBindingType.All:
        boundValue = queryList;
        notify = true;
        break;
    }
    providerData.instance[binding.propName] = boundValue;
  }
  if (notify) {
    queryList.notifyOnChanges();
  }
}

function calcQueryValues(
    view: ViewData, startIndex: number, endIndex: number, queryDef: QueryDef,
    values: any[]): any[] {
  for (let i = startIndex; i <= endIndex; i++) {
    const nodeDef = view.def.nodes[i];
    const valueType = nodeDef.matchedQueries[queryDef.id];
    if (valueType != null) {
      values.push(getQueryValue(view, nodeDef, valueType));
    }
    if (nodeDef.type === NodeType.Element && nodeDef.element.template &&
        (nodeDef.element.template.nodeMatchedQueries & queryDef.filterId) === queryDef.filterId) {
      // check embedded views that were attached at the place of their template.
      const elementData = asElementData(view, i);
      const embeddedViews = elementData.embeddedViews;
      if (embeddedViews) {
        for (let k = 0; k < embeddedViews.length; k++) {
          const embeddedView = embeddedViews[k];
          const dvc = declaredViewContainer(embeddedView);
          if (dvc && dvc === elementData) {
            calcQueryValues(embeddedView, 0, embeddedView.def.nodes.length - 1, queryDef, values);
          }
        }
      }
      const projectedViews = elementData.projectedViews;
      if (projectedViews) {
        for (let k = 0; k < projectedViews.length; k++) {
          const projectedView = projectedViews[k];
          calcQueryValues(projectedView, 0, projectedView.def.nodes.length - 1, queryDef, values);
        }
      }
    }
    if ((nodeDef.childMatchedQueries & queryDef.filterId) !== queryDef.filterId) {
      // if no child matches the query, skip the children.
      i += nodeDef.childCount;
    }
  }
  return values;
}

export function getQueryValue(
    view: ViewData, nodeDef: NodeDef, queryValueType: QueryValueType): any {
  if (queryValueType != null) {
    // a match
    let value: any;
    switch (queryValueType) {
      case QueryValueType.RenderElement:
        value = asElementData(view, nodeDef.index).renderElement;
        break;
      case QueryValueType.ElementRef:
        value = new ElementRef(asElementData(view, nodeDef.index).renderElement);
        break;
      case QueryValueType.TemplateRef:
        value = createTemplateRef(view, nodeDef);
        break;
      case QueryValueType.ViewContainerRef:
        value = createViewContainerRef(view, nodeDef);
        break;
      case QueryValueType.Provider:
        value = asProviderData(view, nodeDef.index).instance;
        break;
    }
    return value;
  }
}