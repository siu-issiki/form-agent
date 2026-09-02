const MAX_CANDIDATE_FIELDS = 200;
const MAX_CANDIDATE_FORMS = 25;

export interface CdpDomNode {
	backendNodeId: number;
	nodeName: string;
	nodeValue?: string;
	baseURL?: string;
	documentURL?: string;
	frameId?: string;
	attributes?: string[];
	children?: CdpDomNode[];
	shadowRoots?: CdpDomNode[];
	contentDocument?: CdpDomNode;
	templateContent?: CdpDomNode;
	shadowRootType?: "user-agent" | "open" | "closed";
}

export interface CdpNavigationLink {
	url: string;
	text: string;
}

export interface CdpFieldCandidate {
	backendNodeId: number;
	tag: string;
}

export interface CdpFormCandidate {
	backendNodeId: number;
	action: string;
	method: string;
	frameId?: string;
	fields: CdpFieldCandidate[];
}

export interface CdpFormDiscovery {
	forms: CdpFormCandidate[];
	nodeCount: number;
	shadowRootCount: number;
	closedShadowRootCount: number;
	candidateFieldCount: number;
}

const FIELD_TAGS = new Set(["input", "textarea", "select", "button"]);

export function discoverCdpForms(
	root: CdpDomNode,
	currentUrl: string,
	topFrameId?: string,
): CdpFormDiscovery {
	const parentByBackendId = new Map<number, number | null>();
	const formsByBackendId = new Map<number, CdpFormCandidate>();
	const formsByHtmlId = new Map<string, CdpFormCandidate>();
	const fields: Array<{ node: CdpDomNode; tag: string }> = [];
	let shadowRootCount = 0;
	let closedShadowRootCount = 0;
	let nodeCount = 0;

	const visit = (
		node: CdpDomNode,
		parentBackendNodeId: number | null,
		inheritedFrameId?: string,
	) => {
		nodeCount += 1;
		const frameId =
			node.nodeName.toLowerCase() === "#document"
				? (node.frameId ?? inheritedFrameId)
				: inheritedFrameId;
		parentByBackendId.set(node.backendNodeId, parentBackendNodeId);
		if (node.shadowRootType) {
			shadowRootCount += 1;
			if (node.shadowRootType === "closed") closedShadowRootCount += 1;
		}

		const tag = node.nodeName.toLowerCase();
		if (tag === "form" && formsByBackendId.size < MAX_CANDIDATE_FORMS) {
			const attributes = parseAttributes(node.attributes);
			const form: CdpFormCandidate = {
				backendNodeId: node.backendNodeId,
				action: resolveFormAction(attributes.action, currentUrl),
				method: (attributes.method || "get").toLowerCase(),
				...(frameId ? { frameId } : {}),
				fields: [],
			};
			formsByBackendId.set(node.backendNodeId, form);
			if (attributes.id) formsByHtmlId.set(attributes.id, form);
		}
		if (FIELD_TAGS.has(tag) && fields.length < MAX_CANDIDATE_FIELDS) {
			fields.push({ node, tag });
		}

		for (const child of [
			...(node.children ?? []),
			...(node.shadowRoots ?? []),
		]) {
			visit(child, node.backendNodeId, frameId);
		}
		if (node.contentDocument) {
			visit(
				node.contentDocument,
				node.backendNodeId,
				node.frameId ?? node.contentDocument.frameId ?? frameId,
			);
		}
		if (node.templateContent) {
			visit(node.templateContent, node.backendNodeId, frameId);
		}
	};

	visit(root, null, root.frameId ?? topFrameId);

	for (const { node, tag } of fields) {
		const attributes = parseAttributes(node.attributes);
		const explicitForm = attributes.form
			? formsByHtmlId.get(attributes.form)
			: undefined;
		const form =
			explicitForm ??
			findAncestorForm(node.backendNodeId, parentByBackendId, formsByBackendId);
		form?.fields.push({ backendNodeId: node.backendNodeId, tag });
	}

	return {
		forms: [...formsByBackendId.values()],
		nodeCount,
		shadowRootCount,
		closedShadowRootCount,
		candidateFieldCount: fields.length,
	};
}

export function discoverCdpNavigationLinks(
	root: CdpDomNode,
	currentUrl: string,
	isAllowed: (url: string) => boolean,
	maxLinks = 20,
): CdpNavigationLink[] {
	const links: CdpNavigationLink[] = [];
	const seen = new Set<string>();
	const current = new URL(currentUrl);
	const visit = (node: CdpDomNode, inheritedBaseUrl: string) => {
		if (links.length >= maxLinks) return;
		const baseUrl = node.baseURL ?? node.documentURL ?? inheritedBaseUrl;
		if (node.nodeName.toLowerCase() === "a") {
			const href = parseAttributes(node.attributes).href;
			try {
				const url = new URL(href ?? "", baseUrl);
				const samePage =
					url.origin === current.origin &&
					url.pathname === current.pathname &&
					url.search === current.search;
				if (
					url.href.length <= 2_048 &&
					!samePage &&
					!seen.has(url.href) &&
					isAllowed(url.href)
				) {
					seen.add(url.href);
					links.push({
						url: url.href,
						text: descendantText(node).slice(0, 500),
					});
				}
			} catch {
				// Ignore malformed or disallowed links.
			}
		}
		for (const child of composedChildren(node)) visit(child, baseUrl);
	};
	visit(root, currentUrl);
	return links;
}

export function discoverCdpBodyBackendNodeIds(
	root: CdpDomNode,
	maxBodies = 20,
	targetFrameId?: string,
): number[] {
	const backendNodeIds: number[] = [];
	const visit = (node: CdpDomNode, inheritedFrameId?: string) => {
		if (backendNodeIds.length >= maxBodies) return;
		const frameId =
			node.nodeName.toLowerCase() === "#document"
				? (node.frameId ?? inheritedFrameId)
				: inheritedFrameId;
		if (
			node.nodeName.toLowerCase() === "body" &&
			(targetFrameId === undefined || frameId === targetFrameId)
		) {
			backendNodeIds.push(node.backendNodeId);
		}
		for (const child of [
			...(node.children ?? []),
			...(node.shadowRoots ?? []),
		]) {
			visit(child, frameId);
		}
		if (node.contentDocument) {
			visit(
				node.contentDocument,
				node.frameId ?? node.contentDocument.frameId ?? frameId,
			);
		}
		if (node.templateContent) visit(node.templateContent, frameId);
	};
	visit(root, root.frameId);
	return backendNodeIds;
}

function descendantText(node: CdpDomNode): string {
	let text = node.nodeName === "#text" ? (node.nodeValue ?? "") : "";
	for (const child of composedChildren(node)) {
		if (text.length >= 500) break;
		text += descendantText(child);
	}
	return text.trim();
}

function composedChildren(node: CdpDomNode): CdpDomNode[] {
	const children = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
	if (node.contentDocument) children.push(node.contentDocument);
	if (node.templateContent) children.push(node.templateContent);
	return children;
}

function findAncestorForm(
	backendNodeId: number,
	parentByBackendId: Map<number, number | null>,
	formsByBackendId: Map<number, CdpFormCandidate>,
): CdpFormCandidate | undefined {
	let parent = parentByBackendId.get(backendNodeId);
	while (parent != null) {
		const form = formsByBackendId.get(parent);
		if (form) return form;
		parent = parentByBackendId.get(parent);
	}
	return undefined;
}

function parseAttributes(values: string[] | undefined): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (let index = 0; index < (values?.length ?? 0); index += 2) {
		const name = values?.[index]?.toLowerCase();
		const value = values?.[index + 1];
		if (name && value !== undefined) attributes[name] = value;
	}
	return attributes;
}

function resolveFormAction(
	action: string | undefined,
	currentUrl: string,
): string {
	try {
		return new URL(action || currentUrl, currentUrl).toString();
	} catch {
		return currentUrl;
	}
}
