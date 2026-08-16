/*
 * Copyright 2010-2025 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global setTimeout, clearTimeout, URL, AbortController */

import {
	launchBrowser,
	closeBrowser as closeBrowserProcess
} from "./browser.js";
import {
	CDP,
	options
} from "simple-cdp";
import {
	FETCH_FUNCTION_NAME,
	RESOLVE_FETCH_FUNCTION_NAME,
	REJECT_FETCH_FUNCTION_NAME,
	getScriptSource,
	getHookScriptSource,
	getPageDataScriptSource
} from "./single-file-script.js";
import {
	fetch,
	waitForTimeout,
	arrayBufferToBase64,
	getAlternativeUrl
} from "./cdp-client-util.js";
import { Deno, path } from "./deno-polyfill.js";

const LOAD_TIMEOUT_ERROR = "ERR_LOAD_TIMEOUT";
const CAPTURE_TIMEOUT_ERROR = "ERR_CAPTURE_TIMEOUT";
const NETWORK_STATES = ["InteractiveTime", "networkIdle", "networkAlmostIdle", "load", "DOMContentLoaded"];
const MINIMIZED_WINDOW_STATE = "minimized";
const SINGLE_FILE_WORLD_NAME = "singlefile";
const CAPTURE_SCREENSHOT_FUNCTION_NAME = "captureScreenshot";
const PRINT_TO_PDF_FUNCTION_NAME = "printToPDF";
const SET_SCREENSHOT_FUNCTION_NAME = "setScreenshot";
const SET_PDF_FUNCTION_NAME = "setPDF";
const SET_PAGE_DATA_FUNCTION_NAME = "setPageData";
const BINDING_CALLED_EVENT_TYPE = "bindingCalled";
const CLEANUP_TIMEOUT = 1000;
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const DOWNLOAD_QUERY_PARAMETER_NAMES = ["attachment", "download", "file", "pdf", "video"];
const DOWNLOAD_FILE_EXTENSIONS = [".pdf", ".zip", ".mp4", ".mp3", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg", ".gif", ".webp"];
const DOWNLOAD_CONTENT_TYPES = ["application/octet-stream", "application/pdf", "application/zip", "audio/mpeg", "video/mp4"];
const MIME_TYPE_EXTENSIONS = {
	"application/pdf": ".pdf",
	"video/mp4": ".mp4",
	"audio/mpeg": ".mp3",
	"application/zip": ".zip"
};
let browserClient, downloadBehaviorLock, downloadState;

export {
	initialize,
	getPageData,
	closeBrowser
};

async function initialize(singleFileOptions) {
	if (singleFileOptions.browserServer) {
		options.apiUrl = singleFileOptions.browserServer;
	} else {
		const LOCALHOST = "http://localhost:";
		const browserOptions = {};
		browserOptions.args = singleFileOptions.browserArgs;
		browserOptions.headless = singleFileOptions.browserHeadless;
		browserOptions.executablePath = singleFileOptions.browserExecutablePath;
		browserOptions.debug = singleFileOptions.browserDebug;
		browserOptions.disableWebSecurity = singleFileOptions.browserDisableWebSecurity;
		browserOptions.width = singleFileOptions.browserWidth;
		browserOptions.height = singleFileOptions.browserHeight;
		browserOptions.userAgent = singleFileOptions.userAgent;
		browserOptions.httpProxyServer = singleFileOptions.httpProxyServer;
		browserOptions.crawlDownloads = singleFileOptions.crawlDownloads;
		options.apiUrl = LOCALHOST + (await launchBrowser(browserOptions));
	}
	browserClient = new CDP(options);
	downloadBehaviorLock = Promise.resolve();
	downloadState = {};
	await setupDownloadBehavior(browserClient, { options: singleFileOptions, debugMessages: [], downloadState });
}

async function closeBrowser() {
	browserClient = undefined;
	downloadState = undefined;
	await closeBrowserProcess();
}

async function getPageData(options) {
	if (options.crawlDownloads && isProbablyDownloadURL(options.url)) {
		const directDownload = await tryDirectDownload(options);
		if (directDownload) {
			return directDownload;
		}
	}
	const EMPTY_PAGE_URL = "about:blank";
	const pageContext = { options, consoleMessages: [], debugMessages: [], httpInfo: {}, downloadState };
	let targetInfo;
	try {
		logData(["Loading page", EMPTY_PAGE_URL], pageContext);
		targetInfo = await CDP.createTarget(EMPTY_PAGE_URL);
		const cdp = new CDP(targetInfo);
		await setupConsoleLogging(cdp, pageContext);
		await setupBrowserWindow(cdp, targetInfo.id, pageContext);
		await setupSecurity(cdp, pageContext);
		await setupDeviceEmulation(cdp, pageContext);
		await setupNetworkInterception(cdp, pageContext);
		await setupScriptInjection(cdp, pageContext);
		const contextId = await getContextId(cdp, pageContext);
		if (contextId && contextId.download) {
			await disableCdpDomains(cdp, pageContext);
			return await finalizePageData(Promise.resolve(contextId), pageContext);
		}
		const pageDataPromise = setupPageDataCapture(cdp, contextId, pageContext);
		await setupBindings(cdp, contextId, pageContext);
		await capturePageData(cdp, contextId, pageContext);
		await disableCdpDomains(cdp, pageContext);
		return await finalizePageData(pageDataPromise, pageContext);
	} catch (error) {
		if (shouldRetryWithFallback(error)) {
			return await retryWithFallback();
		}
		attachDebugInfo(error, pageContext);
		throw error;
	} finally {
		logData(["Closing page"], pageContext);
		await closeTarget();
		logData(["Finishing"], pageContext);
	}

	function shouldRetryWithFallback(error) {
		return error.code === LOAD_TIMEOUT_ERROR &&
			options.browserWaitUntilFallback &&
			options.browserWaitUntil &&
			NETWORK_STATES.indexOf(options.browserWaitUntil) < NETWORK_STATES.length - 1;
	}

	async function retryWithFallback() {
		const browserWaitUntil = NETWORK_STATES[(NETWORK_STATES.indexOf(options.browserWaitUntil) + 1)];
		logData(["Retrying with waitUntil", browserWaitUntil], pageContext);
		options.browserWaitUntil = browserWaitUntil;
		await closeTarget();
		return await getPageData(options);
	}

	async function closeTarget() {
		if (targetInfo && !options.browserDebug) {
			const releaseLock = pageContext.releaseDownloadBehaviorLock || await acquireDownloadBehaviorLock();
			try {
				await executeCleanupOperation(CDP.closeTarget(targetInfo.id));
				await configureDownloadBehavior(browserClient, pageContext, false);
			} finally {
				releaseLock();
			}
			targetInfo = null;
		}
	}
}

async function setupConsoleLogging({ Console }, { options, consoleMessages, debugMessages }) {
	const CONSOLE_MESSAGE_ADDED_EVENT_TYPE = "messageAdded";
	if (options.consoleMessagesFile) {
		logData(["Enabling console messages"], { options, debugMessages });
		await Console.enable();
		Console.addEventListener(CONSOLE_MESSAGE_ADDED_EVENT_TYPE, ({ params }) => {
			consoleMessages.push(params.message);
		});
	}
}

async function tryDirectDownload(options) {
	const headers = new Headers(options.httpHeaders || {});
	const cookieHeader = getCookieHeader(options.url, options.browserCookies);
	if (cookieHeader) {
		headers.set("cookie", cookieHeader);
	}
	const response = await fetch(options.url, { headers });
	const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
	if (contentType && HTML_CONTENT_TYPES.includes(contentType)) {
		return null;
	}
	const contentDisposition = response.headers.get("content-disposition");
	const arrayBuffer = await response.arrayBuffer();
	return {
		filename: getDownloadFilename(options.url, contentDisposition, contentType),
		content: new Uint8Array(arrayBuffer),
		links: []
	};
}

function isProbablyDownloadURL(url) {
	try {
		const parsedUrl = new URL(url);
		const pathname = parsedUrl.pathname.toLowerCase();
		if (DOWNLOAD_FILE_EXTENSIONS.some(extension => pathname.endsWith(extension))) {
			return true;
		}
		return Array.from(parsedUrl.searchParams.keys()).some(parameterName => DOWNLOAD_QUERY_PARAMETER_NAMES.includes(parameterName.toLowerCase()));
	} catch {
		return false;
	}
}

function getCookieHeader(url, cookies = []) {
	try {
		const parsedUrl = new URL(url);
		const now = Date.now() / 1000;
		return cookies
			.filter(cookie => {
				if (!cookie?.name) {
					return false;
				}
				if (cookie.expires && cookie.expires < now) {
					return false;
				}
				if (cookie.secure && parsedUrl.protocol !== "https:") {
					return false;
				}
				if (cookie.domain) {
					const normalizedDomain = cookie.domain.replace(/^\./, "");
					if (parsedUrl.hostname !== normalizedDomain && !parsedUrl.hostname.endsWith("." + normalizedDomain)) {
						return false;
					}
				}
				if (cookie.path && !parsedUrl.pathname.startsWith(cookie.path)) {
					return false;
				}
				return true;
			})
			.map(cookie => `${cookie.name}=${cookie.value}`)
			.join("; ");
	} catch {
		return "";
	}
}

function getDownloadFilename(url, contentDisposition, contentType) {
	const contentDispositionFilename = getFilenameFromContentDisposition(contentDisposition);
	if (contentDispositionFilename) {
		return contentDispositionFilename;
	}
	try {
		const parsedUrl = new URL(url);
		const pathnameFilename = parsedUrl.pathname.split("/").filter(Boolean).pop();
		if (pathnameFilename && pathnameFilename.includes(".")) {
			return pathnameFilename;
		}
		for (const parameterName of DOWNLOAD_QUERY_PARAMETER_NAMES) {
			const parameterValue = parsedUrl.searchParams.get(parameterName);
			if (parameterValue) {
				return appendExtensionIfMissing(parameterValue, contentType);
			}
		}
		return appendExtensionIfMissing(pathnameFilename || "download", contentType);
	} catch {
		return appendExtensionIfMissing("download", contentType);
	}
}

function getFilenameFromContentDisposition(contentDisposition) {
	if (!contentDisposition) {
		return "";
	}
	const filenameStarMatch = contentDisposition.match(/filename\*\s*=\s*([^']*)''([^;]+)/i);
	if (filenameStarMatch) {
		return decodeURIComponent(filenameStarMatch[2]);
	}
	const filenameMatch = contentDisposition.match(/filename\s*=\s*"?([^\";]+)"?/i);
	return filenameMatch ? filenameMatch[1] : "";
}

function appendExtensionIfMissing(filename, contentType) {
	if (!filename || filename.includes(".")) {
		return filename || "download";
	}
	const extension = MIME_TYPE_EXTENSIONS[contentType] || "";
	return filename + extension;
}

async function setupBrowserWindow({ Browser }, targetId, { options, debugMessages }) {
	if (options.browserStartMinimized) {
		const { windowId, bounds } = await Browser.getWindowForTarget({ targetId });
		if (bounds.windowState !== MINIMIZED_WINDOW_STATE) {
			logData(["Minimizing window"], { options, debugMessages });
			await Browser.setWindowBounds({ windowId, bounds: { windowState: MINIMIZED_WINDOW_STATE } });
		}
	}
}

async function setupSecurity({ Security }, { options, debugMessages }) {
	if (options.browserIgnoreHTTPSErrors !== undefined && options.browserIgnoreHTTPSErrors) {
		logData(["Ignoring HTTPS errors"], { options, debugMessages });
		await Security.setIgnoreCertificateErrors({ ignore: true });
	}
}

async function setupDeviceEmulation({ Browser, Emulation, Runtime }, { options, debugMessages }) {
	const needsDeviceMetrics = options.browserMobileEmulation || options.browserDeviceWidth ||
		options.browserDeviceHeight || options.browserDeviceScaleFactor;
	const needsUserAgent = options.browserMobileEmulation || options.platform || options.acceptLanguage;
	if (needsDeviceMetrics) {
		await setupDeviceMetrics({ Emulation, Runtime }, { options, debugMessages });
	}
	if (needsUserAgent) {
		await setupUserAgent({ Browser, Emulation }, { options, debugMessages });
	}
}

async function setupDeviceMetrics({ Emulation, Runtime }, { options, debugMessages }) {
	const INNER_WIDTH_PROPERTY = "window.innerWidth";
	const INNER_HEIGHT_PROPERTY = "window.innerHeight";
	const DEVICE_PIXEL_RATIO_PROPERTY = "window.devicePixelRatio";
	const browserDeviceWidth = options.browserDeviceWidth ||
		(await Runtime.evaluate({ expression: INNER_WIDTH_PROPERTY })).result.value;
	const browserDeviceHeight = options.browserDeviceHeight ||
		(await Runtime.evaluate({ expression: INNER_HEIGHT_PROPERTY })).result.value;
	const browserDeviceScaleFactor = options.browserDeviceScaleFactor ||
		(await Runtime.evaluate({ expression: DEVICE_PIXEL_RATIO_PROPERTY })).result.value;
	const deviceMetricsOptions = {
		mobile: Boolean(options.browserMobileEmulation),
		width: options.browserDeviceWidth || (options.browserMobileEmulation ? 360 : options.width || browserDeviceWidth),
		height: options.browserDeviceHeight || (options.browserMobileEmulation ? 800 : options.height || browserDeviceHeight),
		deviceScaleFactor: options.browserDeviceScaleFactor || (options.browserMobileEmulation ? 2 : browserDeviceScaleFactor)
	};
	logData(["Emulating device metrics", JSON.stringify(deviceMetricsOptions)], { options, debugMessages });
	await Emulation.setDeviceMetricsOverride(deviceMetricsOptions);
}

async function setupUserAgent({ Browser, Emulation }, { options, debugMessages }) {
	const ANDROID_PLATFORM = "Android";
	const { userAgent, product } = await Browser.getVersion();
	const defaultMobileUA = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ${product} Mobile Safari/537.36`;
	const agentOptions = {
		userAgent: options.userAgent || (options.browserMobileEmulation ? defaultMobileUA : userAgent)
	};
	if (options.acceptLanguage) {
		agentOptions.acceptLanguage = options.acceptLanguage;
	}
	if (options.platform || options.browserMobileEmulation) {
		agentOptions.platform = options.platform || ANDROID_PLATFORM;
	}
	logData(["Emulating user agent", JSON.stringify(agentOptions)], { options, debugMessages });
	await Emulation.setUserAgentOverride(agentOptions);
}

async function setupNetworkInterception({ Browser, Emulation, Fetch, Network }, pageContext) {
	const { options, debugMessages, httpInfo } = pageContext;
	const REQUEST_STAGE = "Request";
	const RESPONSE_STAGE = "Response";
	const handleAuthRequests = Boolean(options.httpProxyUsername);
	const patterns = handleAuthRequests ?
		[{ requestStage: REQUEST_STAGE }, { requestStage: RESPONSE_STAGE }] :
		[{ requestStage: RESPONSE_STAGE }];
	await Fetch.enable({ handleAuthRequests, patterns });
	if (handleAuthRequests) {
		setupProxyAuth({ Fetch }, { options, debugMessages });
	}
	setupRequestInterception({ Browser, Fetch }, pageContext);
	if (options.httpHeaders) {
		await setupHttpHeaders({ Network }, { options, debugMessages });
	}
	if (options.emulateMediaFeatures) {
		await setupMediaFeatures({ Emulation }, { options, debugMessages });
	}
	if (options.browserCookies && options.browserCookies.length) {
		await setupCookies({ Network }, { options, debugMessages });
	}
	if (options.crawlDownloads) {
		setupDownloadEvents(Browser, pageContext);
	}
}

async function setupDownloadBehavior({ Browser }, pageContext) {
	const { options, downloadState } = pageContext;
	const DENY_BEHAVIOR = "deny";
	const EVENTS_ENABLED = true;
	if (!options.crawlDownloads) {
		await Browser.setDownloadBehavior({ behavior: DENY_BEHAVIOR });
		return;
	}
	const downloadPath = await getDownloadPath(options.outputDirectory);
	Object.assign(downloadState, {
		downloadPath,
		enabled: true,
		downloads: new Map(),
		waiters: []
	});
	await configureDownloadBehavior({ Browser }, pageContext, EVENTS_ENABLED);
}

async function configureDownloadBehavior({ Browser }, { downloadState }, eventsEnabled) {
	await Browser.setDownloadBehavior({
		behavior: downloadState.enabled ? "allow" : "deny",
		downloadPath: downloadState.downloadPath,
		eventsEnabled
	});
}

function setupDownloadEvents(DownloadDomain, { options, debugMessages, downloadState }) {
	const COMPLETED_DOWNLOAD_STATE = "completed";
	const CANCELED_DOWNLOAD_STATE = "canceled";
	DownloadDomain.addEventListener("downloadWillBegin", ({ params }) => {
		logData(["Beginning download", params.url, params.suggestedFilename], { options, debugMessages });
		let resolveDownload, rejectDownload;
		const download = {
			guid: params.guid,
			frameId: params.frameId,
			url: params.url,
			filename: params.suggestedFilename || getFilenameFromURL(params.url),
			promise: new Promise((resolve, reject) => {
				resolveDownload = resolve;
				rejectDownload = reject;
			}),
			resolve: resolveDownload,
			reject: rejectDownload
		};
		downloadState.downloads.set(download.guid, download);
		downloadState.latestDownload = download;
		const matchingWaiters = downloadState.waiters.filter(waiter => !waiter.frameId || waiter.frameId === download.frameId);
		downloadState.waiters = downloadState.waiters.filter(waiter => waiter.frameId && waiter.frameId !== download.frameId);
		matchingWaiters.forEach(waiter => waiter.resolve(download));
	});
	DownloadDomain.addEventListener("downloadProgress", async ({ params }) => {
		const download = downloadState.downloads.get(params.guid);
		if (!download) {
			return;
		}
		if (params.state === COMPLETED_DOWNLOAD_STATE) {
			try {
				const filePath = await waitForDownloadedFile(params.filePath || path.join(downloadState.downloadPath, download.filename));
				const actualDownloadPath = path.dirname(path.resolve(filePath));
				const expectedDownloadPath = path.resolve(downloadState.downloadPath);
				if (actualDownloadPath !== expectedDownloadPath) {
					throw new Error(`Download saved outside configured directory: ${filePath} (expected directory: ${expectedDownloadPath})`);
				}
				download.filename = getFilenameFromPath(filePath);
				logData(["Completed download", download.url, filePath], { options, debugMessages });
				download.resolve({
					download: true,
					downloadPath: filePath,
					filename: download.filename,
					mimeType: "application/octet-stream",
					content: undefined,
					links: []
				});
			} catch (error) {
				download.reject(error);
			}
			downloadState.downloads.delete(params.guid);
		} else if (params.state === CANCELED_DOWNLOAD_STATE) {
			download.reject(new Error("Download canceled: " + download.url));
			downloadState.downloads.delete(params.guid);
		}
	});
}

async function getDownloadPath(outputDirectory) {
	const downloadPath = path.resolve(outputDirectory || ".");
	await Deno.mkdir(downloadPath, { recursive: true });
	return downloadPath;
}

async function waitForDownloadedFile(filePath) {
	const maxAttempts = 20;
	const delay = 250;
	let previousSize;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const fileInfo = await Deno.stat(filePath);
			if (fileInfo.size > 0 && fileInfo.size === previousSize) {
				return filePath;
			}
			previousSize = fileInfo.size;
		} catch {
			// ignored
		}
		await new Promise(resolve => setTimeout(resolve, delay));
	}
	throw new Error("Downloaded file not found or incomplete: " + filePath);
}

function getFilenameFromURL(url) {
	try {
		const pathname = new URL(url).pathname;
		return pathname.split("/").filter(Boolean).pop() || "download";
	} catch {
		return "download";
	}
}

function getFilenameFromPath(filePath) {
	return filePath.split(/[\\/]/).filter(Boolean).pop() || "download";
}

function setupProxyAuth({ Fetch }, { options, debugMessages }) {
	const AUTH_REQUIRED_EVENT_TYPE = "authRequired";
	const PROVIDE_CREDENTIALS_RESPONSE = "ProvideCredentials";
	Fetch.addEventListener(AUTH_REQUIRED_EVENT_TYPE, async ({ params }) => {
		logData(["Authenticating"], { options, debugMessages });
		await Fetch.continueWithAuth({
			requestId: params.requestId,
			authChallengeResponse: {
				response: PROVIDE_CREDENTIALS_RESPONSE,
				username: options.httpProxyUsername,
				password: options.httpProxyPassword
			}
		});
	});
}

function setupRequestInterception({ Browser, Fetch }, pageContext) {
	const { options, debugMessages, httpInfo } = pageContext;
	const REQUEST_PAUSED_EVENT_TYPE = "requestPaused";
	const ABORTED_ERROR_REASON = "Aborted";
	const urlState = { url: options.url, alternativeUrl: getAlternativeUrl(options.url) };
	Fetch.addEventListener(REQUEST_PAUSED_EVENT_TYPE, async ({ params }) => {
		const { requestId, request } = params;
		captureHttpInfo(params, urlState, { options, debugMessages, httpInfo });
		if (shouldBlockRequest(request.url)) {
			try {
				await Fetch.failRequest({ requestId, errorReason: ABORTED_ERROR_REASON });
				return;
			} catch {
				// ignored
			}
		}
		if (!pageContext.downloadBehaviorSet && isDownloadResponse(params, options)) {
			await configureDownloadBehavior({ Browser }, pageContext, true);
			pageContext.downloadBehaviorSet = true;
		}
		try {
			await Fetch.continueRequest({ requestId });
		} catch {
			// ignored
		}
	});

	function shouldBlockRequest(requestUrl) {
		if (!options.blockedURLPatterns || !options.blockedURLPatterns.length) {
			return false;
		}
		const blockedURL = options.blockedURLPatterns.find(pattern =>
			new RegExp(pattern).test(requestUrl)
		);
		if (blockedURL) {
			logData(["Blocking request", requestUrl], { options, debugMessages });
			return true;
		}
		return false;
	}
}

function isDownloadResponse({ resourceType, responseHeaders = [] }, options) {
	if (!options.crawlDownloads || resourceType !== "Document") {
		return false;
	}
	const headers = new Map(responseHeaders.map(header => [header.name.toLowerCase(), header.value.toLowerCase()]));
	const contentType = headers.get("content-type")?.split(";")[0];
	return headers.get("content-disposition")?.includes("attachment") || DOWNLOAD_CONTENT_TYPES.includes(contentType);
}

function captureHttpInfo(params, urlState, { options, debugMessages, httpInfo }) {
	const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];
	const DOCUMENT_RESOURCE_TYPE = "Document";
	const LOCATION_HEADER_NAME = "location";
	const { request, resourceType, responseHeaders, responseStatusCode, responseStatusText } = params;
	const shouldCapture = resourceType === DOCUMENT_RESOURCE_TYPE &&
		options.outputJson &&
		!httpInfo.request &&
		responseStatusCode !== undefined &&
		(request.url === urlState.url || request.url === urlState.alternativeUrl);
	if (shouldCapture) {
		if (REDIRECT_STATUS_CODES.includes(responseStatusCode)) {
			const redirect = responseHeaders.find(header => header.name.toLowerCase() === LOCATION_HEADER_NAME)?.value;
			if (redirect) {
				urlState.url = new URL(redirect, urlState.url).href;
			}
			logData(["Redirecting", urlState.url], { options, debugMessages });
		} else {
			Object.assign(httpInfo, {
				request: {
					url: request.url,
					method: request.method,
					headers: request.headers,
					referrerPolicy: request.referrerPolicy
				},
				resourceType,
				response: {
					status: responseStatusCode,
					statusText: responseStatusText,
					headers: responseHeaders
				}
			});
		}
	}
}

async function setupHttpHeaders({ Network }, { options, debugMessages }) {
	logData(["Setting HTTP headers", JSON.stringify(options.httpHeaders)], { options, debugMessages });
	await Network.enable();
	await Network.setExtraHTTPHeaders({ headers: options.httpHeaders });
}

async function setupMediaFeatures({ Emulation }, { options, debugMessages }) {
	for (const mediaFeature of options.emulateMediaFeatures) {
		logData(["Emulating media feature", mediaFeature.name, mediaFeature.value], { options, debugMessages });
		await Emulation.setEmulatedMedia({
			media: mediaFeature.name,
			features: mediaFeature.value.split(",").map(feature => feature.trim())
		});
	}
}

async function setupCookies({ Network }, { options, debugMessages }) {
	logData(["Setting cookies", JSON.stringify(options.browserCookies)], { options, debugMessages });
	await Network.setCookies({ cookies: options.browserCookies });
}

async function setupScriptInjection({ Page }, { options }) {
	await Page.addScriptToEvaluateOnNewDocument({
		source: getHookScriptSource(),
		runImmediately: true
	});
	await Page.addScriptToEvaluateOnNewDocument({
		source: await getScriptSource(options),
		runImmediately: true,
		worldName: SINGLE_FILE_WORLD_NAME
	});
}

async function getContextId({ Debugger, Page, Runtime }, pageContext) {
	const { options } = pageContext;
	const [contextId] = await Promise.all([
		loadPage({ Page, Runtime }, pageContext),
		options.browserDebug ? waitForDebuggerReady() : Promise.resolve()
	]);
	return contextId;

	async function waitForDebuggerReady() {
		await Debugger.enable();
		await Debugger.pause();
		await new Promise(resolve => {
			const RESUMED_EVENT = "resumed";
			Debugger.addEventListener(RESUMED_EVENT, onResumed);
			function onResumed() {
				Debugger.removeEventListener(RESUMED_EVENT, onResumed);
				resolve();
			}
		});
	}
}

async function loadPage({ Page, Runtime }, pageContext) {
	const { options, debugMessages, downloadState } = pageContext;
	const LOAD_TIMEOUT_ERROR_MESSAGE = "Load timeout";
	await Runtime.enable();
	await Page.enable();
	const loadTimeoutAbortController = new AbortController();
	const loadTimeoutAbortSignal = loadTimeoutAbortController.signal;
	try {
		logData(["Loading page", options.url], { options, debugMessages });
		const contextIdPromise = getTopFrameContextId({ Page, Runtime }, { options, debugMessages });
		const releaseLock = await acquireDownloadBehaviorLock();
		pageContext.releaseDownloadBehaviorLock = releaseLock;
		let navigateResult;
		try {
			await configureDownloadBehavior(browserClient, pageContext, true);
			navigateResult = await Promise.race([
				Page.navigate({ url: options.url }),
				waitForTimeout(loadTimeoutAbortSignal, options.browserLoadMaxTime, LOAD_TIMEOUT_ERROR_MESSAGE, LOAD_TIMEOUT_ERROR)
			]);
		} finally {
			if (!pageContext.downloadBehaviorSet) {
				releaseLock();
				pageContext.releaseDownloadBehaviorLock = undefined;
			}
		}
		const downloadPromise = options.crawlDownloads ? waitForDownload(downloadState, navigateResult?.frameId) : null;
		if (navigateResult && navigateResult.isDownload && options.crawlDownloads) {
			contextIdPromise.catch(() => {
				// ignored
			});
			return await Promise.race([
				downloadPromise,
				waitForTimeout(loadTimeoutAbortSignal, options.browserLoadMaxTime, LOAD_TIMEOUT_ERROR_MESSAGE, LOAD_TIMEOUT_ERROR)
			]);
		}
		const pendingResults = [
			contextIdPromise,
			waitForTimeout(loadTimeoutAbortSignal, options.browserLoadMaxTime, LOAD_TIMEOUT_ERROR_MESSAGE, LOAD_TIMEOUT_ERROR)
		];
		if (downloadPromise) {
			pendingResults.splice(1, 0, downloadPromise);
		}
		const contextId = await Promise.race(pendingResults);
		return contextId;
	} finally {
		if (!loadTimeoutAbortSignal.aborted) {
			loadTimeoutAbortController.abort();
		}
		await Runtime.disable();
		await Page.disable();
	}
}

function waitForDownload(downloadState, frameId) {
	const download = Array.from(downloadState.downloads.values()).find(download => !frameId || download.frameId === frameId);
	if (download) {
		return download.promise;
	}
	return new Promise((resolve, reject) => {
		downloadState.waiters.push({
			frameId,
			resolve: download => download.promise.then(resolve, reject)
		});
	});
}

async function getTopFrameContextId({ Page, Runtime }, { options, debugMessages }) {
	await Page.setLifecycleEventsEnabled({ enabled: true });
	const state = { topFrameId: undefined, contextIds: [] };
	const removeContextListener = setupContextCreatedListener({ Runtime }, state);
	try {
		await waitForPageReadyState({ Page }, state, { options, debugMessages });
		const contextId = await findValidSingleFileContext({ Runtime }, state.contextIds, { options, debugMessages });
		return contextId;
	} finally {
		removeContextListener();
		await Page.setLifecycleEventsEnabled({ enabled: false });
	}
}

function setupContextCreatedListener({ Runtime }, state) {
	const EXECUTION_CONTEXT_CREATED_EVENT_TYPE = "executionContextCreated";
	const onContextCreated = ({ params }) => {
		const { context } = params;
		if (context.name === SINGLE_FILE_WORLD_NAME && context.auxData?.frameId === state.topFrameId) {
			state.contextIds.push(context.id);
		}
	};
	Runtime.addEventListener(EXECUTION_CONTEXT_CREATED_EVENT_TYPE, onContextCreated);
	return () => Runtime.removeEventListener(EXECUTION_CONTEXT_CREATED_EVENT_TYPE, onContextCreated);
}

async function waitForPageReadyState({ Page }, state, { options, debugMessages }) {
	const LIFE_CYCLE_EVENT_TYPE = "lifecycleEvent";
	const FRAME_NAVIGATED_EVENT_TYPE = "frameNavigated";
	await new Promise((resolve, reject) => {
		const timeoutState = { timeoutId: undefined };
		const cleanup = () => {
			Page.removeEventListener(LIFE_CYCLE_EVENT_TYPE, onLifecycleEvent);
			Page.removeEventListener(FRAME_NAVIGATED_EVENT_TYPE, onFrameNavigated);
		};
		const onLifecycleEvent = createLifecycleEventHandler(state, timeoutState, resolve, cleanup, { options, debugMessages });
		const onFrameNavigated = createFrameNavigatedHandler(state, timeoutState, reject, cleanup, { options, debugMessages });
		Page.addEventListener(LIFE_CYCLE_EVENT_TYPE, onLifecycleEvent);
		Page.addEventListener(FRAME_NAVIGATED_EVENT_TYPE, onFrameNavigated);
	});
}

function createLifecycleEventHandler(state, timeoutState, resolve, cleanup, { options, debugMessages }) {
	return ({ params }) => {
		const { frameId, name } = params;
		if (frameId === state.topFrameId) {
			logData(["Detecting lifecycle event", name], { options, debugMessages });
		}
		const shouldResolve = name === options.browserWaitUntil ||
			(timeoutState.timeoutId && NETWORK_STATES.indexOf(name) < NETWORK_STATES.indexOf(options.browserWaitUntil));
		if (shouldResolve) {
			clearTimeout(timeoutState.timeoutId);
			logData([`Waiting ${options.browserWaitUntilDelay} ms`], { options, debugMessages });
			setTimeout(() => {
				logData(["Detecting page ready"], { options, debugMessages });
				cleanup();
				resolve();
			}, options.browserWaitUntilDelay);
		}
	};
};

function createFrameNavigatedHandler(state, timeoutState, reject, cleanup, { options, debugMessages }) {
	const UNREACHABLE_URL_ERROR_MESSAGE = "Unreachable URL";
	return ({ params }) => {
		const { frame } = params;
		if (!frame.parentId) {
			if (frame.unreachableUrl) {
				clearTimeout(timeoutState.timeoutId);
				cleanup();
				reject(new Error(UNREACHABLE_URL_ERROR_MESSAGE + ": " + frame.unreachableUrl));
			} else {
				logData(["Detecting top frame ID"], { options, debugMessages });
				state.topFrameId = frame.id;
			}
		}
	};
}

async function findValidSingleFileContext({ Runtime }, contextIds, { options, debugMessages }) {
	const CONTEXT_NOT_FOUND_ERROR_MESSAGE = "Execution context not found for SingleFile world";
	const SINGLE_FILE_DETECTION_TEST = "typeof singlefile !== 'undefined'";
	const NO_VALID_CONTEXT_ERROR_MESSAGE = "No valid SingleFile execution context found";
	const CONTEXT_RETRY_TIMEOUT = 5000;
	const CONTEXT_RETRY_DELAY = 100;
	logData(["Getting execution context"], { options, debugMessages });
	const startTime = Date.now();
	let missingContext = false;
	while (Date.now() - startTime < CONTEXT_RETRY_TIMEOUT) {
		if (!contextIds.length) {
			missingContext = true;
		} else {
			for (const contextId of contextIds) {
				try {
					const { result } = await Runtime.evaluate({
						expression: SINGLE_FILE_DETECTION_TEST,
						contextId
					});
					if (result.value === true) {
						return contextId;
					}
				} catch {
					// ignored
				}
			}
		}
		logData(["Waiting for SingleFile execution context"], { options, debugMessages });
		await new Promise(resolve => setTimeout(resolve, CONTEXT_RETRY_DELAY));
	}
	throw new Error(missingContext ? CONTEXT_NOT_FOUND_ERROR_MESSAGE : NO_VALID_CONTEXT_ERROR_MESSAGE);
}

function setupPageDataCapture({ Runtime }, contextId, { options, debugMessages }) {
	return new Promise(resolve => {
		let pageDataResponse = "";
		Runtime.addEventListener(BINDING_CALLED_EVENT_TYPE, ({ params }) => {
			if (params.name === SET_PAGE_DATA_FUNCTION_NAME) {
				const { payload } = params;
				if (payload.length) {
					pageDataResponse += payload;
				} else {
					logData(["Setting page data"], { options, debugMessages });
					const result = JSON.parse(pageDataResponse);
					if (result.content instanceof Array) {
						result.content = new Uint8Array(result.content);
					}
					resolve(result);
				}
			}
		});
	});
}

async function setupBindings({ Page, Runtime }, contextId, { options, debugMessages }) {
	await Runtime.addBinding({ name: SET_PAGE_DATA_FUNCTION_NAME, executionContextId: contextId });
	if (options.embedScreenshot && options.compressContent) {
		await setupScreenshotCapture({ Page, Runtime }, contextId, { options, debugMessages });
	}
	if (options.embedPdf) {
		await setupPdfCapture({ Page, Runtime }, contextId, { options, debugMessages });
	}
	await Runtime.addBinding({ name: FETCH_FUNCTION_NAME, executionContextId: contextId });
	Runtime.addEventListener(BINDING_CALLED_EVENT_TYPE, async ({ params }) => {
		if (params.name === FETCH_FUNCTION_NAME) {
			await handleFetchRequest({ Runtime }, params, contextId, { options, debugMessages });
		}
	});
}

async function setupScreenshotCapture({ Page, Runtime }, contextId, { options, debugMessages }) {
	await Runtime.addBinding({ name: CAPTURE_SCREENSHOT_FUNCTION_NAME, executionContextId: contextId });
	Runtime.addEventListener(BINDING_CALLED_EVENT_TYPE, async ({ params }) => {
		if (params.name === CAPTURE_SCREENSHOT_FUNCTION_NAME) {
			logData(["Capturing screenshot"], { options, debugMessages });
			try {
				const screenshotOptions = parseScreenshotOptions(options.embedScreenshotOptions);
				const { data } = await Page.captureScreenshot(screenshotOptions);
				await callBrowserFunction({ Runtime }, contextId, SET_SCREENSHOT_FUNCTION_NAME, [data]);
			} catch {
				await callBrowserFunction({ Runtime }, contextId, SET_SCREENSHOT_FUNCTION_NAME, [""]);
			}
		}
	});

	function parseScreenshotOptions(optionsString) {
		const PNG_FORMAT = "png";
		let screenshotOptions = { captureBeyondViewport: true };
		if (optionsString) {
			try {
				screenshotOptions = JSON.parse(optionsString);
			} catch {
				// ignored
			}
		}
		screenshotOptions.format = PNG_FORMAT;
		return screenshotOptions;
	}
}

async function setupPdfCapture({ Page, Runtime }, contextId, { options, debugMessages }) {
	await Runtime.addBinding({ name: PRINT_TO_PDF_FUNCTION_NAME, executionContextId: contextId });
	Runtime.addEventListener(BINDING_CALLED_EVENT_TYPE, async ({ params }) => {
		if (params.name !== PRINT_TO_PDF_FUNCTION_NAME) {
			logData(["Printing to PDF", options.embedPdfOptions || ""], { options, debugMessages });
			const pdfOptions = parsePdfOptions(options.embedPdfOptions);
			try {
				const { data } = await Page.printToPDF(pdfOptions);
				await callBrowserFunction({ Runtime }, contextId, SET_PDF_FUNCTION_NAME, [data]);
			} catch {
				await callBrowserFunction({ Runtime }, contextId, SET_PDF_FUNCTION_NAME, [""]);
			}
		}
	});

	function parsePdfOptions(optionsString) {
		let pdfOptions = {};
		if (optionsString) {
			try {
				pdfOptions = JSON.parse(optionsString);
			} catch {
				// ignored
			}
		}
		return pdfOptions;
	}
}

async function handleFetchRequest({ Runtime }, params, contextId, { options, debugMessages }) {
	const { payload } = params;
	const { requestId, url, options: fetchOptions } = JSON.parse(payload);
	logData(["Fetching URL", url], { options, debugMessages });
	try {
		const response = await fetch(url, fetchOptions);
		const arrayBuffer = await response.arrayBuffer();
		const base64Data = arrayBufferToBase64(arrayBuffer);
		const result = {
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			data: base64Data
		};
		await callBrowserFunction({ Runtime }, contextId, RESOLVE_FETCH_FUNCTION_NAME, [requestId, result]);
	} catch (error) {
		const errorResult = {
			error: error.message,
			code: error.code
		};
		await callBrowserFunction({ Runtime }, contextId, REJECT_FETCH_FUNCTION_NAME, [requestId, errorResult]);
	}
}

async function callBrowserFunction({ Runtime }, contextId, functionName, args) {
	const serializedArgs = args.map(arg => JSON.stringify(arg)).join(", ");
	await Runtime.evaluate({
		expression: `globalThis.${functionName}(${serializedArgs})`,
		contextId
	});
}

async function capturePageData({ Runtime }, contextId, { options, debugMessages }) {
	const CAPTURE_TIMEOUT_ERROR_MESSAGE = "Capture timeout";
	const ERROR_SUBTYPE = "error";
	const captureTimeoutAbortController = new AbortController();
	const captureTimeoutAbortSignal = captureTimeoutAbortController.signal;
	if (options.browserWaitDelay) {
		logData([`Waiting ${options.browserWaitDelay} ms`], { options, debugMessages });
		await new Promise(resolve => setTimeout(resolve, options.browserWaitDelay));
	}
	try {
		logData(["Capturing page"], { options, debugMessages });
		const captureScript = `(${getPageDataScriptSource.toString()})(${JSON.stringify(options)},${JSON.stringify([
			SET_SCREENSHOT_FUNCTION_NAME,
			SET_PDF_FUNCTION_NAME,
			SET_PAGE_DATA_FUNCTION_NAME,
			CAPTURE_SCREENSHOT_FUNCTION_NAME,
			PRINT_TO_PDF_FUNCTION_NAME
		])})`;
		const { result } = await Promise.race([
			Runtime.evaluate({
				expression: captureScript,
				awaitPromise: true,
				returnByValue: true,
				contextId
			}),
			waitForTimeout(captureTimeoutAbortSignal, options.browserCaptureMaxTime, CAPTURE_TIMEOUT_ERROR_MESSAGE, CAPTURE_TIMEOUT_ERROR)
		]);
		if (result.subtype === ERROR_SUBTYPE) {
			throw new Error(result.description);
		}
	} finally {
		if (!captureTimeoutAbortSignal.aborted) {
			captureTimeoutAbortController.abort();
		}
	}
}

async function disableCdpDomains({ Console, Network, Page, Runtime }, { options }) {
	await executeCleanupOperation(Runtime.disable());
	await executeCleanupOperation(Page.disable());
	if (options.httpHeaders) {
		await executeCleanupOperation(Network.disable());
	}
	if (options.consoleMessagesFile) {
		await executeCleanupOperation(Console.disable());
	}
}

async function finalizePageData(pageDataPromise, { options, consoleMessages, debugMessages, httpInfo }) {
	const pageData = await pageDataPromise;
	logData(["Returning page data"], { options, debugMessages });
	if (options.consoleMessagesFile) {
		pageData.consoleMessages = consoleMessages;
	}
	if (options.debugMessagesFile) {
		pageData.debugMessages = debugMessages;
	}
	Object.assign(pageData, httpInfo);
	if (options.browserWaitEndDelay) {
		logData([`Waiting ${options.browserWaitEndDelay} ms after processing`], { options, debugMessages });
		await new Promise(resolve => setTimeout(resolve, options.browserWaitEndDelay));
	}
	return pageData;
}

function attachDebugInfo(error, { options, consoleMessages, debugMessages }) {
	if (options.consoleMessagesFile) {
		error.consoleMessages = consoleMessages;
	}
	if (options.debugMessagesFile) {
		error.debugMessages = debugMessages;
	}
}

function logData(data, { options, debugMessages }) {
	if (options.debugMessagesFile) {
		debugMessages.push([Date.now(), data]);
	}
}

async function acquireDownloadBehaviorLock() {
	let releaseLock;
	const previousOperation = downloadBehaviorLock;
	downloadBehaviorLock = new Promise(resolve => releaseLock = resolve);
	await previousOperation;
	return releaseLock;
}

async function executeCleanupOperation(promise) {
	try {
		await Promise.race([
			promise,
			new Promise(resolve => setTimeout(resolve, CLEANUP_TIMEOUT))
		]);
	} catch {
		// ignored
	}
}
