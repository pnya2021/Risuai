import { allowedDbKeys, applyProgrammaticDatabaseMutation, customProviderStore, getV2PluginAPIs, handlePluginInstallViaPlugin, pluginV2, type PluginV2ProviderArgument, type PluginV2ProviderOptions, type RisuPlugin } from "../plugins.svelte";
import { invokeSandboxCleanupCallback, SandboxHost } from "./factory";
import { replacePluginV3RuntimeSnapshot } from "../pluginV3Reload";
import { getCurrentCharacter, getCurrentChat, getDatabase } from "src/ts/storage/database.svelte";
import { SafeLocalPluginStorage, tagWhitelist } from "../pluginSafeClass";
import DOMPurify from 'dompurify';
import { additionalChatMenu, additionalFloatingActionButtons, additionalHamburgerMenu, additionalSettingsMenu, bodyIntercepterStore, chatPanelStore, DBState, selectedCharID, type MenuDef } from "src/ts/stores.svelte";
import { v4 } from "uuid";
import { sleep } from "src/ts/util";
import { alertConfirm, alertError, alertNormal } from "src/ts/alert";
import { language } from "src/lang";
import { checkCharOrder, fetchPluginPolicyNative, forageStorage, getAssetStorageRevision, getFetchLogs, readImage, requestDatabaseSaveNow, waitForMessagePersistence } from "src/ts/globalApi.svelte";
import { changeColorScheme, updateColorScheme, updateTextThemeAndCSS, type ColorScheme } from "src/ts/gui/colorscheme";
import { isNodeServer, isTauri } from "src/ts/platform";
import { get } from "svelte/store";
import { registerMCPModule, registeredCustomPluginMCPs, unregisterMCPModule } from "src/ts/process/mcp/pluginmcp";
import { getInlayAsset, getInlayAssetBlob, getInlayAssetRecord, listInlayAssets, removeInlayAsset, writeInlayImageFromBytes } from "src/ts/process/files/inlays";
import { coldStorageHeader, getColdStorageItem, listColdDataKeys, preLoadChat } from "src/ts/process/coldstorage.svelte";
import { getLLMCache, searchLLMCache } from "src/ts/translator/translator";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from "src/ts/model/types";
import { sendChat as processSendChat, doingChat } from "src/ts/process/index.svelte";
import { getModelInfo } from "src/ts/model/modellist";
import type { ModelModeExtended } from "src/ts/process/request/shared";
import { requestChatDataMain } from "src/ts/process/request/request";
import { getActiveModulesWithReasons, getModuleLorebooks } from "src/ts/process/modules";
import {
    registerTTSPreprocessor,
    unregisterTTSPreprocessor,
    registerTTSPostprocessor,
    unregisterTTSPostprocessor,
    type BeforeTTSContext,
    type BeforeTTSResult,
    type AfterTTSContext,
    type AfterTTSResult,
    type TTSHookFn,
} from "src/ts/process/ttsHooks";
import { getCapabilities } from './illustration/capabilities';
import {
    createPluginExecutionContext,
    isPluginPermissionId,
    pluginPermissionService,
    type PluginExecutionContext,
    type PluginPermissionId,
} from './illustration/permissions';
import { pluginDataLifecycle } from '../pluginDataLifecycle';
import { stripPluginPrincipal } from '../pluginPrincipal';
import { cleanupOwnedProviderRegistration, InstanceChannelRegistry, InstanceCleanupRegistry, OwnedTimeoutSet, registerInstanceResourceIfActive, removeOwnedArrayEntry, removeOwnedMapEntry, retainOrCleanupInstanceResource } from './pluginInstanceResources';
import { invokePermissionCheckedProvider } from './providerPermission';
import { isCurrentPluginRuntimeRecord } from '../pluginRuntimeReplacement';
import { ContextResourceService } from './illustration/contextResources';
import { createRisuContextResourceAdapter } from './illustration/contextResources.risu';
import { PluginSecretService, protectedPluginSecretBackend } from './illustration/pluginSecretStore';
import { PluginNativeFetchService } from './illustration/nativeFetch';
import { PluginApiError } from './illustration/errors';
import { INLAY_LIFECYCLE_CAPABILITY_IDS, InlayLifecycleService } from './illustration/inlayLifecycle';
import { createRisuInlayLifecycleAdapter } from './illustration/inlayLifecycle.risu';
import { DEVICE_CACHE_CAPABILITY_IDS, DeviceCacheService } from './illustration/deviceCache';
import { getPixaiInstallLifecycle, getPixaiSessionBroker } from './localModel/pixaiInstallLifecycle';
import { PixaiLocalModel, withPixaiInferenceCapability } from './localModel/pixaiLocalModel';
import { MESSAGE_QUERY_CAPABILITY_IDS, MessageQueryService, type MessageRef } from './illustration/messageQuery';
import { createRisuMessageQueryAdapter } from './illustration/messageQuery.risu';
import { MESSAGE_PATCH_CAPABILITY_IDS, MessagePatchService, type MessagePatchInput } from './illustration/messagePatch';
import { createRisuMessagePatchAdapter } from './illustration/messagePatch.risu';

/*
    V3 API for RisuAI Plugins

    Before adding new APIs here, please check the limitations

    - APIs must be a functions
        - If you want nested objects, first add as a plain function, `_getPluginStorage` for example
            And add it too _getAliases function ({'pluginStorage':{'getItem': '_getPluginStorage', ... }})
            This will make pluginStorage.getItem() work in plugins
        - If you need constants, use _getPropertiesForInitialization to set them up
            For example apiVersion and apiVersionCompatibleWith are set this way,
            Accessable in plugins as risuai.apiVersion
    - APIs must return, or accept as parameters, only the following types:
        - Serializable data (string, number, boolean, null, array, object)
        - Class instances marked with __classType = 'REMOTE_REQUIRED'
        - Callback functions (only as parameters)
        - Note that Class or Callbacks inside arrays or objects are not supported
*/

const pluginChannels = new InstanceChannelRegistry();
const pluginInstanceCleanup = new InstanceCleanupRegistry();

class SafeElement {
    #element: HTMLElement;
    __classType = 'REMOTE_REQUIRED' as const;

    constructor(element: HTMLElement, protected readonly instanceId?: string) {
        if(element.getAttribute('freezed')){
            throw new Error("This element cannot be accessed by SafeELement")
        }
        this.#element = element;
    }

    public appendChild(child: SafeElement) {
        this.#element.appendChild(child.#element);
    }

    public removeChild(child: SafeElement) {
        this.#element.removeChild(child.#element);
    }

    public replaceChild(newChild: SafeElement, oldChild: SafeElement) {
        this.#element.replaceChild(newChild.#element, oldChild.#element);
    }

    public replaceWith(newElement: SafeElement) {
        this.#element.replaceWith(newElement.#element);
    }

    public cloneNode(deep: boolean = false): SafeElement {
        const cloned = this.#element.cloneNode(deep);
        return new SafeElement(cloned as HTMLElement, this.instanceId);
    }

    public prepend(child: SafeElement) {
        this.#element.prepend(child.#element);
    }

    public remove() {
        this.#element.remove();
    }

    public innerText(): string {
        return this.#element.innerText;
    }

    public textContent(): string | null {
        return this.#element.textContent;
    }

    public setTextContent(value: string) {
        this.#element.textContent = value;
    }

    public setInnerText(value: string) {
        this.#element.innerText = value;
    }


    public setAttribute(name: string, value: string) {
        if(!name.startsWith('x-')){
            throw new Error("Can only set attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.");
        }
        this.#element.setAttribute(name, value);
    }
    public getAttribute(name: string): string | null {
        if(!name.startsWith('x-')){
            throw new Error("Can only get attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.");
        }
        return this.#element.getAttribute(name);
    }
    public setStyle(property: string, value: string) {
        (this.#element.style as any)[property] = value;
    }
    public getStyle(property: string): string {
        return (this.#element.style as any)[property];
    }
    public getStyleAttribute(): string {
        return this.#element.getAttribute('style') || '';
    }
    public setStyleAttribute(value: string) {
        this.#element.setAttribute('style', value);
    }
    public addClass(className: string) {
        // 
        this.#element.classList.add(className);
    }
    public removeClass(className: string) {
        // 
        this.#element.classList.remove(className);
    }
    public setClassName(className: string){
        this.#element.className = className
    }
    public getClassName(){
        return this.#element.className
    }
    public hasClass(className: string): boolean {
        //We don't need to check the className here since we're just checking
        return this.#element.classList.contains(className);
    }
    public focus() {
        this.#element.focus();
    }
    public getChildren(): SafeClassArray<SafeElement> {
        const children: SafeElement[] = [];
        this.#element.childNodes.forEach(node => {
            if(node instanceof HTMLElement) {
                children.push(new SafeElement(node, this.instanceId));
            }
        });
        return new SafeClassArray<SafeElement>(children);
    }
    public getParent(): SafeElement | null {
        if(this.#element.parentElement) {
            return new SafeElement(this.#element.parentElement, this.instanceId);
        }
        return null;
    }
    public getInnerHTML(): string {
        return this.#element.innerHTML;
    }
    public getOuterHTML(): string {
        return this.#element.outerHTML;
    }
    public clientHeight(): number {
        return this.#element.clientHeight;
    }
    public clientWidth(): number {
        return this.#element.clientWidth;
    }
    public clientTop(): number {
        return this.#element.clientTop;
    }
    public clientLeft(): number {
        return this.#element.clientLeft;
    }
    public nodeName(): string {
        return this.#element.nodeName;
    }
    public nodeType(): number {
        return this.#element.nodeType;
    }
    public querySelectorAll(selector: string): SafeClassArray<SafeElement> {
        const nodeList = this.#element.querySelectorAll(selector);
        const elements: SafeElement[] = [];
        nodeList.forEach(node => {
            if(node instanceof HTMLElement) {
                elements.push(new SafeElement(node, this.instanceId));
            }
        });
        return new SafeClassArray<SafeElement>(elements);
    }
    public querySelector(selector: string): SafeElement | null {
        const element = this.#element.querySelector(selector);
        if(element instanceof HTMLElement) {
            return new SafeElement(element, this.instanceId);
        }
        return null;
    }
    public getElementById(id: string): SafeElement | null {
        const element = this.querySelector('#' + id);
        return element;
    }
    public getElementsByClassName(className: string): SafeClassArray<SafeElement> {
        return this.querySelectorAll('.' + className);
    }
    public getClientRects(): DOMRectList {
        return this.#element.getClientRects();
    }
    public getBoundingClientRect(): DOMRect {
        return this.#element.getBoundingClientRect();
    }
    public setInnerHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.innerHTML = san;
    }
    public setOuterHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.outerHTML = san;
    }
    public scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
        this.#element.scrollIntoView(options);
    }
    #eventIdMap = new Map<string, Function>()
    #eventCleanupMap = new Map<string, () => void>()

    public async addEventListener(type:string, listener: (event: any) => void, options?: boolean | AddEventListenerOptions):Promise<string> {
        const realOptions = typeof options === 'boolean' ? { capture: options } : options || {};

        //allowed with unlimited
        const allowedDocumentEventListeners = [
            'click',
            'dblclick',
            'contextmenu',
            'mousedown',
            'mouseup',
            'mousemove',
            'mouseover',
            'mouseleave',
            'pointercancel',
            'pointerdown',
            'pointerenter',
            'pointerleave',
            'pointermove',
            'pointerout',
            'pointerover',
            'pointerup',
            'scroll',
            'scrollend'
        ]

        //allowed, but it has fingerprinting issues,
        //so it will be delayed random ms.
        const allowedDelayedEventListeners = [
            'keydown',
            'keyup',
            'keypress'
        ]

        const id = v4()

        const trimEvent = (event: MouseEvent | KeyboardEvent | Event) => {
            if(event instanceof MouseEvent){
                return {
                    type: event.type,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    button: event.button,
                    buttons: event.buttons,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                }
            }
            else if(event instanceof KeyboardEvent){
                return {
                    type: event.type,
                    key: event.key,
                    code: event.code,
                    repeat: event.repeat,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                }
            }
            else{
                return {
                    type: event.type
                }
            }

        }

        if(allowedDocumentEventListeners.includes(type)){
            const modifiedListener = (event: any) => {
                listener(trimEvent(event))
            }
            this.#eventIdMap.set(id, modifiedListener)
            document.addEventListener(type, modifiedListener, realOptions)
            const cleanup = () => {
                document.removeEventListener(type, modifiedListener, realOptions)
                if (this.#eventIdMap.get(id) === modifiedListener) this.#eventIdMap.delete(id)
                this.#eventCleanupMap.delete(id)
            }
            this.#eventCleanupMap.set(id, cleanup)
            if (this.instanceId) pluginInstanceCleanup.add(this.instanceId, cleanup)
            return id;
        }
        else if(allowedDelayedEventListeners.includes(type)){
            const pending = new OwnedTimeoutSet()
            const modifiedListener = (event: any) => {
                let delay = 0;
                try {
                    delay = (crypto.getRandomValues(new Uint32Array(1))[0] / 100) % 100; //0-99 ms              
                } catch (error) {}
                const trimmed = trimEvent(event)
                pending.schedule(() => {
                    if (this.#eventIdMap.get(id) === modifiedListener) listener(trimmed)
                }, delay)
            }
            this.#eventIdMap.set(id, modifiedListener)
            document.addEventListener(type, modifiedListener, realOptions);
            const cleanup = () => {
                document.removeEventListener(type, modifiedListener, realOptions)
                pending.clear()
                if (this.#eventIdMap.get(id) === modifiedListener) this.#eventIdMap.delete(id)
                this.#eventCleanupMap.delete(id)
            }
            this.#eventCleanupMap.set(id, cleanup)
            if (this.instanceId) pluginInstanceCleanup.add(this.instanceId, cleanup)
            return id;
        }
        else{
            throw new Error(`Event listener of type '${type}' is not allowed for security reasons.`);
        }        
    }

    public removeEventListener(type:string, id:string, options?: boolean | EventListenerOptions) {
        const cleanup = this.#eventCleanupMap.get(id)
        if (cleanup) {
            cleanup()
            return
        }
        const listener = this.#eventIdMap.get(id);
        if(listener){
            const realOptions = typeof options === 'boolean' ? { capture: options } : options || {};
            document.removeEventListener(type, listener as EventListenerOrEventListenerObject, realOptions);
            this.#eventIdMap.delete(id);
        }
    }

    public matches (selector: string): boolean {
        return this.#element.matches(selector);
    }
}

class SafeDocument extends SafeElement {
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(document: Document, instanceId: string) {
        super(document.documentElement, instanceId);
    }
    createElement(tagName: string): SafeElement {
        if(!tagWhitelist.includes(tagName.toLowerCase())) {
            console.warn(`Creation of <${tagName}> elements is restricted. Creating a <div> instead.`);
            tagName = 'div';
        }
        if(tagName.toLowerCase() === 'a'){
            console.warn(`<a> can be created but href attribute cannot be set directly for security reasons. Use .createAnchorElement(href: string) to create safe anchor elements.`);
        }
        const element = document.createElement(tagName);
        return new SafeElement(element, this.instanceId);
    }
    createAnchorElement(href: string): SafeElement {
        const anchor = document.createElement('a');
        try {
            const url = new URL(href);
            if(url.protocol !== 'http:' && url.protocol !== 'https:'){
                throw new Error("Invalid protocol");
            }
            anchor.setAttribute('href', url.toString());
        } catch (error) {
            console.warn(`Invalid URL provided for anchor element: ${href}. Setting href to '#' instead.`);
            anchor.setAttribute('href', '#');
        }
        return new SafeElement(anchor, this.instanceId);
    }
}

type SafeMutationRecordObject = {
    type: string;
    target: SafeElement;
    addedNodes: SafeElement[];
}

class SafeClassArray<T> {
    #items: T[];
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(items: T[] = []) {
        this.#items = items;
    }
    at(index: number): T {
        return this.#items.at(index);
    }
    length(): number {
        return this.#items.length;
    }
    push(item: T) {
        this.#items.push(item);
    }
}

class SafeMutationRecord{
    __classType = 'REMOTE_REQUIRED' as const;
    #type: string;
    #target: SafeElement;
    #addedNodes: SafeClassArray<SafeElement>;
    constructor(type: string, target: SafeElement, addedNodes: SafeElement[]) {
        this.#type = type;
        this.#target = target;
        this.#addedNodes = new SafeClassArray<SafeElement>(addedNodes);
    }
    getType(): string {
        return this.#type;
    }
    getTarget(): SafeElement {
        return this.#target;
    }
    getAddedNodes(): SafeClassArray<SafeElement> {
        return this.#addedNodes;
    }
}

type SafeMutationCallback = (mutations: SafeClassArray<SafeMutationRecord>) => void;

class SafeMutationObserver {
    #observer: MutationObserver;
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(callback: SafeMutationCallback, private readonly instanceId: string) {
        this.#observer = new MutationObserver((mutations) => {
            const safeMutations: SafeMutationRecordObject[] = mutations.map(mutation => {

                const elementMapHelper = (nodeList: NodeList): SafeElement[] => {
                    const elements: SafeElement[] = [];
                    nodeList.forEach(node => {
                        if(node instanceof HTMLElement) {
                            elements.push(new SafeElement(node, this.instanceId));
                        }
                    })
                    return elements;
                }

                return {
                    type: mutation.type,
                    target: new SafeElement(mutation.target as HTMLElement, this.instanceId),
                    addedNodes: elementMapHelper(mutation.addedNodes),
                    removedNodes: elementMapHelper(mutation.removedNodes)
                    
                }
            })

            const safeClassed = new SafeClassArray<SafeMutationRecord>([]);
            for(const record of safeMutations){
                safeClassed.push(new SafeMutationRecord(
                    record.type,
                    record.target,
                    record.addedNodes
                ));
            }
            callback(safeClassed);
        });
    }

    observe(element:SafeElement, options: MutationObserverInit) {
        const identifier = v4();
        element.setAttribute('x-identifier', identifier);
        const rawElement = document.querySelector(`[x-identifier="${identifier}"]`) as HTMLElement;
        if(rawElement){
            this.#observer.observe(rawElement, options);
            element.setAttribute('x-identifier', '');
        }
    }

    disconnect() {
        this.#observer.disconnect();
    }

}

const addPluginUnloadCallback = (instanceId: string, callback: () => void | Promise<void>) =>
    pluginInstanceCleanup.add(instanceId, callback)

const makeMenuUnloadCallback = (menuStore: MenuDef[], expected: MenuDef) =>
    () => removeOwnedArrayEntry(menuStore, expected)

const removeChatPanel = (id: string) => {
    const index = chatPanelStore.findIndex(item => item.id === id);
    if(index !== -1){
        chatPanelStore.splice(index, 1);
    }
}

export const unloadV3Plugin = async (identifier: string) => {
    const instance = v3PluginInstances.find(p => p.instanceId === identifier || p.name === identifier);
    const pluginName = instance?.name ?? identifier
    const instanceId = instance?.instanceId ?? identifier
    const callbacks = pluginInstanceCleanup.take(instanceId)
    if(instance){
        const index = v3PluginInstances.indexOf(instance);
        if(index !== -1){
            v3PluginInstances.splice(index, 1);
        }
        instance.unregisterStop()
        instance.abortController.abort()
    }
    if(callbacks.length){
        const cleanup = Promise.allSettled(callbacks.map((callback) => Promise.resolve().then(callback)))
        await Promise.race([cleanup, sleep(1000)])
    }
    try {
        instance?.host?.terminate();        
    } catch (error) {
        console.error(`Error terminating plugin ${pluginName}:`, error);
    }
}

type PluginV3ProviderOptions = PluginV2ProviderOptions & {
    model?: LLMModel
}

export const customV3ProviderMetaStore:LLMModel[] = []

const getPluginPermission = async (
    context: PluginExecutionContext,
    permissionDesc: PluginPermissionId,
    reconfirm: boolean|'periodically' = false,
) => pluginPermissionService.request(context, permissionDesc, {
    reconfirm,
    locale: DBState.db.language === 'ko' ? 'ko' : 'en',
})

const urlBlacklist = [
    'risuai.xyz',
    'risuai.net',
    'sionyw.com',
]

const authorizationHeaders = [
    'x-api-key',
    'authorization',
    'proxy-authorization',
]

const makeRisuaiAPIV3 = (iframe:HTMLIFrameElement,plugin:RisuPlugin, context: PluginExecutionContext) => {

    const isExecutionCurrent = () => isCurrentPluginRuntimeRecord(
        plugin, getDatabase().plugins ?? [], (principalId) => pluginDataLifecycle.isRetiring(principalId),
    )
    const canRegisterResource = () => !context.signal.aborted && isExecutionCurrent()
    const oldApis = getV2PluginAPIs(canRegisterResource, isExecutionCurrent);
    const contextResources = new ContextResourceService(
        context,
        createRisuContextResourceAdapter({
            getDatabase,
            getCurrentCharacter,
            getCurrentChat,
            getActiveModulesWithReasons,
            readImage,
            getAssetStorageRevision,
        }),
        {
            requirePermission: (permission) => pluginPermissionService.require(context, permission, {
                locale: DBState.db.language === 'ko' ? 'ko' : 'en',
            }),
        },
    )
    const inlayLifecycle = new InlayLifecycleService(
        context,
        createRisuInlayLifecycleAdapter({
            getDatabase,
            getCurrentCharacter,
            listColdDataKeys,
            getColdStorageItem,
            getInlayAssetRecord,
            writeInlayImageFromBytes,
            removeInlayAsset,
        }),
        {
            require: (executionContext, permission) => pluginPermissionService.require(executionContext, permission, {
                locale: DBState.db.language === 'ko' ? 'ko' : 'en',
            }),
        },
    )
    const messageQuery = new MessageQueryService(
        context,
        createRisuMessageQueryAdapter({
            getDatabase,
            getCurrentCharacter,
            getCurrentChat,
            preLoadChat,
            coldStorageHeader,
            listInlayAssets,
        }),
        {
            requirePermission: (executionContext, permission) => pluginPermissionService.require(
                executionContext,
                permission,
                { locale: DBState.db.language === 'ko' ? 'ko' : 'en' },
            ),
        },
    )
    const messagePatch = new MessagePatchService(
        context,
        createRisuMessagePatchAdapter({
            getDatabase,
            getCurrentCharacter,
            getCurrentChat,
            preLoadChat,
            coldStorageHeader,
            listInlayAssets,
            waitForMessagePersistence,
            requestDatabaseSaveNow,
        }),
        {
            requirePermission: (executionContext, permission) => pluginPermissionService.require(
                executionContext,
                permission,
                { locale: DBState.db.language === 'ko' ? 'ko' : 'en' },
            ),
        },
    )
    const deviceCache = new DeviceCacheService(context)
    const pixaiLocalModel = new PixaiLocalModel({
        context,
        getBroker: () => getPixaiSessionBroker(),
        getStatus: (profile) => getPixaiInstallLifecycle().getLocalModelStatus(context, profile),
        backendHealthy: () => {
            if (
                isNodeServer ||
                typeof Worker === 'undefined' ||
                typeof WebAssembly === 'undefined' ||
                typeof OffscreenCanvas === 'undefined' ||
                typeof createImageBitmap === 'undefined' ||
                typeof Blob === 'undefined'
            ) return false
            try {
                getPixaiSessionBroker()
                return true
            } catch {
                return false
            }
        },
        storageBackend: isTauri ? 'cache' : 'opfs',
        contextResources,
        requirePermission: (permission) => pluginPermissionService.require(context, permission, {
            locale: DBState.db.language === 'ko' ? 'ko' : 'en',
        }),
        getInlayAssetRecord,
        getInlayAssetBlob,
    })
    addPluginUnloadCallback(context.instanceId, () => pixaiLocalModel.releaseAll())
    const secretService = new PluginSecretService(context, protectedPluginSecretBackend, {
        requirePermission: () => pluginPermissionService.require(context, 'secrets', {
            locale: DBState.db.language === 'ko' ? 'ko' : 'en',
        }),
        locale: DBState.db.language === 'ko' ? 'ko' : 'en',
    })
    const pluginNativeFetch = new PluginNativeFetchService(secretService, { request: fetchPluginPolicyNative })
    return {

        //Old APIs from v2.1
        risuFetch: (url, options) => {
            console.error(`[DEPRECATION WARNING] risuFetch is deprecated and will be removed in future versions. Please use nativeFetch instead.`)
            for(const blocked of urlBlacklist){
                if(url.toLowerCase().includes(blocked)){
                    throw new Error(`Requests to ${blocked} are blocked for security reasons.`);
                }
            }

            //scan headers
            const headers = options?.headers || {};
            for(const headerName in headers){
                if(authorizationHeaders.includes(headerName.toLowerCase())){
                    console.warn(`Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to only work with nativeFetch.`);
                }
            }
            return oldApis.risuFetch(url, options);
        },
        nativeFetch: (url, options) => pluginNativeFetch.fetch(url, options),
        setPluginSecret: (id: string, value: string, policy) => secretService.setPluginSecret(id, value, policy),
        hasPluginSecret: (id: string) => secretService.hasPluginSecret(id),
        deletePluginSecret: (id: string) => secretService.deletePluginSecret(id),
        getChar: oldApis.getChar,
        setChar: oldApis.setChar,
        addProvider: (name: string, func: (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string }>, options?: PluginV3ProviderOptions) => {
            console.warn(`[WARN] addProvider is a powerful API that can potentially be unsafe if used incorrectly. addProvider's functionality might be limited or changed in future updates to ensure security. please use other APIs if possible.`);
            const providerCallback = async (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => {
                return invokePermissionCheckedProvider(
                    () => getPluginPermission(context, 'provider', 'periodically'),
                    async (authorizedArg, authorizedSignal) => {
                        // mode is overridden to v3 due to vulnerabilities using mode.
                        authorizedArg.mode = 'v3'
                        return func(authorizedArg, authorizedSignal)
                    },
                    arg,
                    abortSignal,
                    context.signal,
                )
            }
            const providerOptions = options ?? {}
            const modelData:LLMModel = {
                id: `pluginmodel:::${name}`,
                name: options?.model?.name ?? name,
                shortName: options?.model?.shortName ?? name,
                fullName: options?.model?.fullName ?? name,
                internalID: options?.model?.internalID ?? `pluginmodel:::${name}`,
                provider: LLMProvider.AsIs,
                format: LLMFormat.Plugin,
                flags: options?.model?.flags ?? [LLMFlags.hasFullSystemPrompt],
                parameters: options?.model?.parameters ?? ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'min_p', 'top_a', 'top_k', 'thinking_tokens'],
                tokenizer:options?.model?.tokenizer ??  LLMTokenizer.Unknown
            }
            if (!registerInstanceResourceIfActive(canRegisterResource, () => {
                pluginV2.providers.set(name, providerCallback)
                pluginV2.providerOptions.set(name, providerOptions)
                customProviderStore.set([...get(customProviderStore).filter((provider) => provider !== name), name])
                const previousMetaIndex = customV3ProviderMetaStore.findIndex((model) => model.id === modelData.id)
                if (previousMetaIndex >= 0) customV3ProviderMetaStore[previousMetaIndex] = modelData
                else customV3ProviderMetaStore.push(modelData)
            })) return
            addPluginUnloadCallback(context.instanceId, () => {
                cleanupOwnedProviderRegistration({
                    name, provider: providerCallback, options: providerOptions,
                    providers: pluginV2.providers, providerOptions: pluginV2.providerOptions,
                    removeName: () => customProviderStore.set(get(customProviderStore).filter((provider) => provider !== name)),
                    removeModel: () => removeOwnedArrayEntry(customV3ProviderMetaStore, modelData),
                })
            })
        },
        addTTSPreprocessor: async (
            func: TTSHookFn<BeforeTTSContext, BeforeTTSResult>,
        ) => {
            if (!canRegisterResource()) return
            registerTTSPreprocessor(func);
            addPluginUnloadCallback(context.instanceId, () => unregisterTTSPreprocessor(func));
        },
        addTTSPostprocessor: async (
            func: TTSHookFn<AfterTTSContext, AfterTTSResult>,
        ) => {
            if (!canRegisterResource()) return
            registerTTSPostprocessor(func);
            addPluginUnloadCallback(context.instanceId, () => unregisterTTSPostprocessor(func));
        },
        addRisuScriptHandler: (name: Parameters<typeof oldApis.addRisuScriptHandler>[0], func: Parameters<typeof oldApis.addRisuScriptHandler>[1]) => {
            if (!canRegisterResource()) return
            oldApis.addRisuScriptHandler(name, func)
            addPluginUnloadCallback(context.instanceId, () => oldApis.removeRisuScriptHandler(name, func))
        },
        removeRisuScriptHandler: oldApis.removeRisuScriptHandler,
        addRisuReplacer: async (name:string,func:Function) => {
            //permission check for replacer
            const conf = await getPluginPermission(context, 'replacer', 'periodically');
            if(!conf){
                return;
            }
            if (!canRegisterResource()) return
            oldApis.addRisuReplacer(name, func as any);
            addPluginUnloadCallback(context.instanceId, () => oldApis.removeRisuReplacer(name, func as any))
        },
        removeRisuReplacer: oldApis.removeRisuReplacer,
        setDatabaseLite: (newDb: any) => applyProgrammaticDatabaseMutation(newDb, 'lite', canRegisterResource, isExecutionCurrent),
        setDatabase: (newDb: any) => applyProgrammaticDatabaseMutation(newDb, 'approved', canRegisterResource, isExecutionCurrent),
        loadPlugins: async () => {
            if (!canRegisterResource()) return
            await oldApis.loadPlugins()
        },
        readImage: oldApis.readImage,
        readInlay: async (id: string) => {
            return await getInlayAsset(id);
        },
        createInlay: (data, options) => inlayLifecycle.createInlay(data, options),
        deleteInlay: (id, options) => inlayLifecycle.deleteInlay(id, options),
        putDeviceCacheEntry: (input) => deviceCache.putDeviceCacheEntry(input),
        getDeviceCacheEntry: (key) => deviceCache.getDeviceCacheEntry(key),
        listDeviceCacheEntries: (options) => deviceCache.listDeviceCacheEntries(options),
        deleteDeviceCacheEntry: (key, options) => deviceCache.deleteDeviceCacheEntry(key, options),
        clearDeviceCache: (options) => deviceCache.clearDeviceCache(options),
        saveAsset: oldApis.saveAsset,
        //Same functionality, but new implementation
        getDatabase: async (includeOnly:string[]|'all' = 'all') => {
            const conf = await getPluginPermission(context, 'db', 'periodically');
            if(!conf){
                return null;
            }
            const db = DBState.db
            let liteDB = {}
            for(const key of allowedDbKeys){
                if(includeOnly !== 'all' && !includeOnly.includes(key)){
                    continue;
                }
                const value = key === 'plugins'
                    ? (db.plugins ?? []).map((installed) => stripPluginPrincipal(installed))
                    : (db as any)[key]
                ;(liteDB as any)[key] = $state.snapshot(value);
            }
            return liteDB;
        },

        installPlugin: async (plugins: RisuPlugin[]) => {
            if (!canRegisterResource()) return []
            const approved = await handlePluginInstallViaPlugin(plugins, canRegisterResource)
            return canRegisterResource() ? approved : []
        },

        // --- Color Scheme APIs ---
        changeColorScheme: (name: string) => {
            changeColorScheme(name)
        },
        setColorScheme: (scheme: ColorScheme) => {
            const requiredKeys = ['bgcolor','darkbg','borderc','selected','draculared','textcolor','textcolor2','darkBorderc','darkbutton','type'] as const
            for (const key of requiredKeys) {
                if (typeof (scheme as any)[key] !== 'string') {
                    throw new Error(`Invalid color scheme: missing or invalid '${key}'`)
                }
            }
            if (scheme.type !== 'light' && scheme.type !== 'dark') {
                throw new Error('Invalid color scheme type: must be "light" or "dark"')
            }
            const db = DBState.db
            db.colorSchemeName = 'custom'
            db.colorScheme = scheme
            updateColorScheme()
        },
        getColorScheme: () => {
            const db = DBState.db
            return {
                name: db.colorSchemeName,
                scheme: $state.snapshot(db.colorScheme)
            }
        },

        // --- Text Theme APIs ---
        changeTextTheme: (name: string) => {
            if (!['standard','highcontrast'].includes(name)) {
                throw new Error(`Invalid text theme: ${name}`)
            }
            const db = DBState.db
            db.textTheme = name
            updateTextThemeAndCSS()
        },
        setCustomTextTheme: (theme: {
            FontColorStandard: string,
            FontColorBold: string,
            FontColorItalic: string,
            FontColorItalicBold: string,
            FontColorQuote1: string,
            FontColorQuote2: string
        }) => {
            const requiredKeys = ['FontColorStandard','FontColorBold','FontColorItalic','FontColorItalicBold','FontColorQuote1','FontColorQuote2'] as const
            for (const key of requiredKeys) {
                if (typeof (theme as any)[key] !== 'string') {
                    throw new Error(`Invalid text theme: missing or invalid '${key}'`)
                }
            }
            const db = DBState.db
            db.textTheme = 'custom'
            db.customTextTheme = theme
            updateTextThemeAndCSS()
        },
        getTextTheme: () => {
            const db = DBState.db
            return {
                name: db.textTheme,
                customTheme: $state.snapshot(db.customTextTheme)
            }
        },

        //Deprecated APIs from v2.1
        //Use getArgument / setArgument instead if possible
        getArg: oldApis.getArg,
        setArg: oldApis.setArg,

        //New APIs for v3
        getArgument: async (key:string) => {
            const db = getDatabase()
            for (const p of db.plugins) {
                if (p.name === plugin.name) {
                    return p.realArg[key];
                }
            }
        },
        setArgument: async (key:string, value:string) => {
            const db = getDatabase();
            for (const p of db.plugins) {
                if (p.name === plugin.name) {
                    p.realArg[key] = value;
                }
            }
        },
        getCharacterFromIndex: (index:number) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[index];
            if(charId){
                return $state.snapshot(db.characters[charId]);
            }
            return null;
        },
        setCharacterToIndex: (index:number, char:any) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[index];
            if(charId){
                DBState.db.characters[charId] = char
            }
        },
        getChatFromIndex: (characterIndex:number, chatIndex:number) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[characterIndex];
            if(charId){
                const chats = db.characters[charId].chats;
                if(chats && chats[chatIndex]){
                    return $state.snapshot(chats[chatIndex]);
                }
            }
            return null;
        },
        setChatToIndex: (characterIndex:number, chatIndex:number, chat:any) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[characterIndex];
            if(charId){
                const chats = db.characters[charId].chats;
                if(chats && chats[chatIndex]){
                    DBState.db.characters[charId].chats[chatIndex] = chat
                }
            }
        },
        getCurrentCharacterIndex: () => {
            return get(selectedCharID)
        },
        getCurrentChatIndex: () => {
            const db = DBState.db
            const charId = get(selectedCharID)
            return db.characters[charId].chatPage
        },
        getCurrentLorebookEntries: () => {
            const charId = get(selectedCharID)
            const char = DBState.db.characters[charId]
            if(!char){
                return []
            }
            const page = char.chatPage
            const characterLore = char.globalLore ?? []
            const chatLore = char.chats?.[page]?.localLore ?? []
            const moduleLore = getModuleLorebooks()
            return $state.snapshot(characterLore.concat(chatLore).concat(moduleLore))
        },
        //New names for character APIs, to match API naming conventions
        getCharacter: oldApis.getChar,
        setCharacter: oldApis.setChar,

        showContainer: (
            //more types may be added in future
            type: 'fullscreen' = 'fullscreen'
        ) => {
            iframe.style.display = "block";
            
            switch(type) {
                case 'fullscreen': {
                    //move iframe to body if not already there
                    if(iframe.parentElement !== document.body) {
                        document.body.appendChild(iframe);
                    }

                    //Make iframe cover whole screen
                    iframe.style.position = "fixed";
                    iframe.style.top = "0";
                    iframe.style.left = "0";
                    iframe.style.width = "100%";
                    iframe.style.height = "100%";
                    iframe.style.border = "none";
                    iframe.style.zIndex = "1000";
                    break;
                }
                default: {
                    return
                }
            }
        },
        hideContainer: () => {
            iframe.style.display = "none";
        },
        getRootDocument: async () => {
            const conf = await getPluginPermission(context, 'mainDom');
            if(!conf || !canRegisterResource()){
                return null;
            }
            return new SafeDocument(document, context.instanceId);
        },
        registerSetting: (
            name:string,
            callback: any,
            icon:string = '',
            iconType:'html'|'img'|'none' = 'none',
            id?:string
        ) => {
            if (!canRegisterResource()) return null
            if(iconType !== 'html' && iconType !== 'img' && iconType !== 'none'){
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if(typeof name !== 'string' || name.trim() === ''){
                throw new Error("name must be a non-empty string");
            }
            const menuId = id || v4()
            const menuDef:MenuDef = {
                id: menuId,
                name,
                icon,
                iconType,
                callback
            }
            const existingIndex = additionalSettingsMenu.findIndex(item => item.id === menuId)
            if(existingIndex !== -1){
                additionalSettingsMenu[existingIndex] = menuDef
                addPluginUnloadCallback(
                    context.instanceId,
                    makeMenuUnloadCallback(additionalSettingsMenu, menuDef)
                )
                return {id: menuId}
            }
            additionalSettingsMenu.push(menuDef)
            addPluginUnloadCallback(
                context.instanceId,
                makeMenuUnloadCallback(additionalSettingsMenu, menuDef)
            )
            return {id: menuId};
        },
        registerBodyIntercepter: async (callback: (body: any, type: string) => any) => {

            if(await getPluginPermission(context, 'replacer') === false){
                return null;
            }
            if (!canRegisterResource()) return null
            
            const id = v4();
            bodyIntercepterStore.push({
                id,
                callback
            })
            addPluginUnloadCallback(context.instanceId, () => {
                const index = bodyIntercepterStore.findIndex(item => item.id === id);
                if(index !== -1){
                    bodyIntercepterStore.splice(index, 1);
                }
            })
            return {id:id};
        },
        
        unregisterBodyIntercepter: (id: string) => {
            const index = bodyIntercepterStore.findIndex(item => item.id === id);
            if(index !== -1){
                bodyIntercepterStore.splice(index, 1);
            }
        },
            
        registerButton: (
            arg: {
                name: string,
                icon: string,
                iconType: 'html'|'img'|'none',
                location?: 'action'|'chat'|'hamburger',
                id?: string
            },
            callback: () => void
        ) => {
            if (!canRegisterResource()) return null
            let { name, icon, iconType, location, id: providedId } = arg;
            location = location || 'action';
            if(iconType !== 'html' && iconType !== 'img' && iconType !== 'none'){
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if(typeof name !== 'string' || name.trim() === ''){
                throw new Error("name must be a non-empty string");
            }
            if(typeof icon !== 'string'){
                throw new Error("icon must be a string");
            }
            const id = providedId || v4()
            const menuDef:MenuDef = {
                name,
                icon,
                iconType,
                callback,
                id
            }

            const buttonStores = [additionalFloatingActionButtons, additionalHamburgerMenu, additionalChatMenu]
            for(const store of buttonStores){
                const existingIndex = store.findIndex(item => item.id === id)
                if(existingIndex !== -1){
                    store[existingIndex] = menuDef
                    addPluginUnloadCallback(
                        context.instanceId,
                        makeMenuUnloadCallback(store, menuDef)
                    )
                    return {id}
                }
            }

            switch(location){
                case 'action':{
                    additionalFloatingActionButtons.push(menuDef)
                    addPluginUnloadCallback(
                        context.instanceId,
                        makeMenuUnloadCallback(additionalFloatingActionButtons, menuDef)
                    )
                    break
                }
                case 'hamburger':{
                    additionalHamburgerMenu.push(menuDef)
                    addPluginUnloadCallback(
                        context.instanceId,
                        makeMenuUnloadCallback(additionalHamburgerMenu, menuDef)
                    )
                    break
                }
                case 'chat':{
                    additionalChatMenu.push(menuDef)
                    addPluginUnloadCallback(
                        context.instanceId,
                        makeMenuUnloadCallback(additionalChatMenu, menuDef)
                    )
                    break
                }
                default:{
                    throw new Error("Invalid location for button")
                }
            }
            return {id};
        },
        setChatPanel: (
            content: string | null,
            options: {
                id?: string,
                className?: string,
            } = {}
        ) => {
            if (!canRegisterResource()) return null
            const id = options.id || `${plugin.name}:default`;

            if(content === null || content === ''){
                removeChatPanel(id);
                return {id};
            }

            if(typeof content !== 'string'){
                throw new Error("content must be a string or null");
            }

            const panel = {
                id,
                pluginName: plugin.name,
                html: DOMPurify.sanitize(content),
                className: typeof options.className === 'string'
                    ? DOMPurify.sanitize(options.className, {ALLOWED_TAGS: [], ALLOWED_ATTR: []})
                    : undefined,
            }

            const existingIndex = chatPanelStore.findIndex(item => item.id === id);
            if(existingIndex !== -1){
                chatPanelStore[existingIndex] = panel;
            }
            else{
                chatPanelStore.push(panel);
            }
            addPluginUnloadCallback(context.instanceId, () => removeOwnedArrayEntry(chatPanelStore, panel));
            return {id};
        },
        registerMCP: async (...args: Parameters<typeof registerMCPModule>) => {
            if (!canRegisterResource()) return
            await registerMCPModule(...args)
            const identifier = args[0].identifier
            const ownedClient = registeredCustomPluginMCPs.get(identifier)
            const cleanup = async () => {
                if (registeredCustomPluginMCPs.get(identifier) === ownedClient) await unregisterMCPModule(identifier)
            }
            await retainOrCleanupInstanceResource(context.signal, cleanup, (callback) => {
                addPluginUnloadCallback(context.instanceId, callback)
            })
        },
        unregisterMCP: unregisterMCPModule,
        unregisterUIPart: (id: string) => {
            const removeFromMenuStore = (menuStore: MenuDef[]) => {
                const index = menuStore.findIndex(item => item.id === id);
                if(index !== -1){
                    menuStore.splice(index, 1);
                }
            }

            removeFromMenuStore(additionalSettingsMenu);
            removeFromMenuStore(additionalFloatingActionButtons);
            removeFromMenuStore(additionalHamburgerMenu);
            removeFromMenuStore(additionalChatMenu);
            removeChatPanel(id);
        },
        log: (message:string) => {
            console.log(`[RisuAI Plugin: ${plugin.name}] ${message}`);
        },
        createMutationObserver(callback: SafeMutationCallback): SafeMutationObserver {
            if (!canRegisterResource()) throw new Error('Plugin instance is no longer active')
            const observer = new SafeMutationObserver(callback, context.instanceId)
            addPluginUnloadCallback(context.instanceId, () => {
                observer.disconnect()
            })
            return observer
        },
        onUnload: (callback: () => void) => {
            if (!canRegisterResource()) return
            addPluginUnloadCallback(context.instanceId, () => invokeSandboxCleanupCallback(callback));
        },
        getFetchLogs: async () => {
            const unsafeFetchLog = getFetchLogs()
            const conf = await getPluginPermission(context, 'fetchLogs');
            if(!conf){
                return null;
            }
            return unsafeFetchLog.map(log => {

                const url = new URL(log.url);
                return {
                    url: url.origin + url.pathname,
                    body: log.body,
                    status: log.status,
                    response: log.response,
                }
            })
        },

        alert: (msg:string) => {
            return alertNormal(msg)
        },
        alertConfirm: (msg:string) => {
            return alertConfirm(msg)
        },
        alertError: (msg:string) => {
            return alertError(msg)
        },
        getRuntimeInfo: () => {
            return {
                apiVersion: "3.0",
                platform: 
                    isNodeServer ? 'node' :
                    isTauri ? 'tauri' :
                    'web',
                saveMethod:
                    isTauri ? 'tauri' :
                    forageStorage.isAccount ? 'account' :
                    'local',
            }
        },
        getLocalPluginStorage: () => {
            return new SafeLocalPluginStorage()
        },
        checkCharOrder: checkCharOrder,
        requestPluginPermission: (permission:string) => {
            if (!isPluginPermissionId(permission)) return Promise.resolve(false)
            return getPluginPermission(context, permission);
        },
        getCapabilities: async (ids?: string[]) => {
            const secretStatus = await protectedPluginSecretBackend.status()
            const registeredServices = await withPixaiInferenceCapability(
                ids,
                [
                    'context.current.v1',
                    'context.assets.v1',
                    'context.modules-installed.v1',
                    'secrets.write-only.v1',
                    ...MESSAGE_QUERY_CAPABILITY_IDS,
                    ...MESSAGE_PATCH_CAPABILITY_IDS,
                    ...INLAY_LIFECYCLE_CAPABILITY_IDS,
                    ...DEVICE_CACHE_CAPABILITY_IDS,
                ],
                () => pixaiLocalModel.backendHealthy(),
            )
            return getCapabilities(context, ids, {
                permissionState: (principalId, permission) => pluginPermissionService.state(principalId, permission),
                runtime: {
                    registeredServices,
                    hasCurrentContext: Boolean(getCurrentCharacter() && getCurrentChat()),
                    unavailableReasons: secretStatus.available ? {} : { 'secrets.write-only.v1': 'disabled' },
                },
            })
        },
        getLocalModelStatus: (profile: unknown) =>
            getPixaiInstallLifecycle().getLocalModelStatus(context, profile),
        getLocalModelCapabilities: (profile: unknown) =>
            pixaiLocalModel.getLocalModelCapabilities(profile),
        installLocalModel: (profile: unknown, onProgress?: unknown) =>
            getPixaiInstallLifecycle().installLocalModel(context, profile, onProgress),
        getLocalModelOperation: (operationId: unknown) =>
            getPixaiInstallLifecycle().getLocalModelOperation(context, operationId),
        cancelLocalModelOperation: (operationId: unknown) =>
            getPixaiInstallLifecycle().cancelLocalModelOperation(context, operationId),
        removeLocalModel: (profile: unknown, options?: unknown) =>
            getPixaiInstallLifecycle().removeLocalModel(context, profile, options),
        acquireLocalModelSession: (profile: unknown, options?: unknown) =>
            pixaiLocalModel.acquireLocalModelSession(profile, options),
        runLocalModel: (sessionId: unknown, request: unknown, options?: unknown) =>
            pixaiLocalModel.runLocalModel(sessionId, request, options),
        releaseLocalModelSession: (sessionId: unknown) =>
            pixaiLocalModel.releaseLocalModelSession(sessionId),
        getCurrentContext: () => contextResources.getCurrentContext(),
        getCharacterCardSnapshot: (characterId?: string) => contextResources.getCharacterCardSnapshot(characterId),
        getConversationContextSnapshot: (conversationId?: string) => contextResources.getConversationContextSnapshot(conversationId),
        listContextAssets: (options) => contextResources.listContextAssets(options),
        getActiveModules: (options) => contextResources.getActiveModules(options),
        listContextModules: (options) => contextResources.listContextModules(options),
        readContextAsset: (assetId: string, options) => contextResources.readContextAsset(assetId, options),
        getMessageSnapshot: (target: MessageRef) => messageQuery.getMessageSnapshot(target),
        getLatestCommittedMessage: (options?: Parameters<MessageQueryService['getLatestCommittedMessage']>[0]) =>
            messageQuery.getLatestCommittedMessage(options),
        getRecentCommittedMessages: (options: Parameters<MessageQueryService['getRecentCommittedMessages']>[0]) =>
            messageQuery.getRecentCommittedMessages(options),
        patchMessage: (input: MessagePatchInput) => messagePatch.patchMessage(input),
        //Internal use APIs
        _getOldKeys: () => {
            return Object.keys(oldApis)
        },
        _getPropertiesForInitialization: () => {
            const v = {
                apiVersion: "3.0",
                apiVersionCompatibleWith: ["3.0"],
            } as any;

            v.list = Object.keys(v);
            
            return v;
        },
        _getPluginStorage: oldApis.pluginStorage.getItem,
        _setPluginStorage: oldApis.pluginStorage.setItem,
        _removePluginStorage: oldApis.pluginStorage.removeItem,
        _clearPluginStorage: oldApis.pluginStorage.clear,
        _keyPluginStorage: oldApis.pluginStorage.key,
        _keysPluginStorage: oldApis.pluginStorage.keys,
        _lengthPluginStorage: oldApis.pluginStorage.length,
        _getSafeLocalStorage: oldApis.safeLocalStorage.getItem,
        _setSafeLocalStorage: oldApis.safeLocalStorage.setItem,
        _removeSafeLocalStorage: oldApis.safeLocalStorage.removeItem,
        _clearSafeLocalStorage: oldApis.safeLocalStorage.clear,
        _keySafeLocalStorage: oldApis.safeLocalStorage.key,
        _keysSafeLocalStorage: oldApis.safeLocalStorage.keys,
        searchTranslationCache: async (partialKey: string) => {
            return searchLLMCache(partialKey)
        },
        getTranslationCache: async (key: string) => {
            return getLLMCache(key)
        },
        _getAliases: () => {
            return {
                'pluginStorage':{
                    'getItem': '_getPluginStorage',
                    'setItem': '_setPluginStorage',
                    'removeItem': '_removePluginStorage',
                    'clear': '_clearPluginStorage',
                    'key': '_keyPluginStorage',
                    'keys': '_keysPluginStorage',
                    'length': '_lengthPluginStorage',
                },
                'safeLocalStorage':{
                    'getItem': '_getSafeLocalStorage',
                    'setItem': '_setSafeLocalStorage',
                    'removeItem': '_removeSafeLocalStorage',
                    'clear': '_clearSafeLocalStorage',
                    'key': '_keySafeLocalStorage',
                    'keys': '_keysSafeLocalStorage',
                }
            }
        },
        runLLMModel: async (options: {
            mode: ModelModeExtended
            messages: OpenAIChat[]
            staticModel?: string
            allowPlugins?: boolean
        }) => {
            return requestChatDataMain({
                formated: options.messages,
                bias: {},
                staticModel: options.staticModel,

                // Calls into plugin-provided models are blocked by default to
                // guard against accidental IPC loops between provider plugins.
                // Plugin authors who need to reach the user's plugin-supplied
                // main or auxiliary model (e.g. a TTS preprocessor that
                // rewrites text with the configured otherAx model) can opt in
                // explicitly with `allowPlugins: true`, accepting responsibility
                // for avoiding provider-to-provider call loops.
                blockPlugins: !options.allowPlugins,
            }, options.mode)
        },
        sendChat: async (message: string) => {
            const conf = await getPluginPermission(context, 'sendChat');
            if(!conf){
                return false;
            }

            if(typeof message !== 'string'){
                throw new Error("Message must be a string");
            }

            if(get(doingChat)){
                throw new Error("A chat is already in progress");
            }

            if(getModelInfo(DBState.db.aiModel).id.startsWith('pluginmodel:::')){
                // Executing plugin provider is block because it can be used for loopholes for ipc right now.
                throw new Error("Sending chat with plugin-based model is currently blocked");
            }

            const charId = get(selectedCharID);
            const char = DBState.db.characters[charId];
            if(!char){
                throw new Error("No character selected");
            }

            const chat = char.chats[char.chatPage];
            if(!chat){
                throw new Error("No active chat found");
            }

            if(message){
                chat.message.push({
                    role: 'user',
                    data: message,
                    time: Date.now(),
                });
            }

            try {
                await processSendChat(-1, {});
            } finally {
                // Plugin API path does not pass through the UI unlock logic,
                // so release doingChat here on both success and failure.
                doingChat.set(false);
            }

            return true;
        },
        addPluginChannelListener: (channelName: string, callback: Function) => {
            if (!canRegisterResource()) return
            pluginChannels.register(plugin.name, channelName, context.instanceId, callback);
            addPluginUnloadCallback(context.instanceId, () => {
                pluginChannels.removeOwned(plugin.name, channelName, context.instanceId);
            })
        },
        postPluginChannelMessage: (pluginName: string, channelName: string, message: any) => {

            const currentPluginName = plugin.name;
            const receiverPlugin = DBState.db.plugins.find(p => p.name === pluginName);

            if(!receiverPlugin){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to non-existent plugin '${pluginName}' on channel '${channelName}'.`);
                return;
            }

            if(!receiverPlugin.allowedIPC?.includes(currentPluginName)){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but receiver plugin does not allow IPC communication from this plugin. declare //@allowed-ipc ${currentPluginName} in the reciver plugin script to allow IPC communication.`);
                return;
            }

            if(!plugin.allowedIPC?.includes(receiverPlugin.name)){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but the sender plugin does not allow IPC communication to this plugin. declare //@allowed-ipc ${receiverPlugin.name} in the sender plugin script to allow IPC communication.`);
                return;
            }


            const callback = pluginChannels.get(pluginName, channelName);
            if(callback){
                callback(message, {
                    sender: currentPluginName,
                    channel: channelName
                });
            }
        },
        saveSecretHeader: async () => {
            throw new PluginApiError('UNSUPPORTED', 'saveSecretHeader is unsafe and unsupported; use setPluginSecret with an exact origin policy')
        },
    }
}

type V3PluginInstance = {
    name: string;
    principalId: string;
    instanceId: string;
    abortController: AbortController;
    unregisterStop: () => void;
    host: SandboxHost;
}

const v3PluginInstances: V3PluginInstance[] = [];

export async function loadV3Plugins(plugins:RisuPlugin[]){
    await replacePluginV3RuntimeSnapshot({
        liveInstances: v3PluginInstances,
        plugins,
        unload: (instance) => unloadV3Plugin(instance.instanceId),
        load: executePluginV3,
    })
}

export async function executePluginV3(plugin:RisuPlugin){

    if (!isCurrentPluginRuntimeRecord(
        plugin, getDatabase().plugins ?? [], (principalId) => pluginDataLifecycle.isRetiring(principalId),
    )) {
        console.warn(`[RisuAI Plugin: ${plugin.name}] Skipped stale or retired runtime snapshot.`)
        return
    }

    if (!plugin.principalId) {
        throw new Error(`Plugin ${plugin.name} is missing its Host principal.`)
    }

    const alreadyRunning = v3PluginInstances.find(p => p.principalId === plugin.principalId);
    if(alreadyRunning){
        console.log(`[RisuAI Plugin: ${plugin.name}] Plugin is already running. Skipping load.`);
        return;
    }

    const iframe = document.createElement('iframe');
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    const { context, abortController } = createPluginExecutionContext({
        principalId: plugin.principalId, name: plugin.name, displayName: plugin.displayName,
    })
    const authorizeExecution = () => !context.signal.aborted && isCurrentPluginRuntimeRecord(
        plugin, getDatabase().plugins ?? [], (principalId) => pluginDataLifecycle.isRetiring(principalId),
    )
    const host = new SandboxHost(
        makeRisuaiAPIV3(iframe, plugin, context),
        authorizeExecution,
        () => abortController.abort(),
        authorizeExecution,
    );
    const instance: V3PluginInstance = {
        name: plugin.name,
        principalId: plugin.principalId,
        instanceId: context.instanceId,
        abortController,
        unregisterStop: () => undefined,
        host,
    }
    instance.unregisterStop = pluginDataLifecycle.registerInstanceStop(
        plugin.principalId,
        context.instanceId,
        () => unloadV3Plugin(context.instanceId),
    )
    v3PluginInstances.push(instance);
    host.run(iframe, plugin.script);
    console.log(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`);
}

export function getV3PluginInstance(name: string) {
    return v3PluginInstances.find(p => p.name === name);
}

globalThis.__debugV3Plugin = (code: string|Function, pluginName: string = '') => {
    if(code instanceof Function){
        code = `(${code.toString()})()`;
    }
    if(pluginName === ''){
        return v3PluginInstances[0].host.executeInIframe(code);
    }
    const instance = v3PluginInstances.find(p => p.name === pluginName);
    if(!instance){
        throw new Error(`Plugin ${pluginName} not found.`);
    }
    return instance.host.executeInIframe(code);
};
