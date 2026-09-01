const MAX_CANDIDATE_FIELDS = 200;
const MAX_CANDIDATE_FORMS = 25;

export interface CdpDomNode {
	backendNodeId: number;
	nodeName: string;
	attributes?: string[];
	children?: CdpDomNode[];
	shadowRoots?: CdpDomNode[];
	contentDocument?: CdpDomNode;
	templateContent?: CdpDomNode;
	shadowRootType?: "user-agent" | "open" | "closed";
}

export interface CdpFieldCandidate {
	backendNodeId: number;
	tag: string;
}

export interface CdpFormCandidate {
	backendNodeId: number;
	action: string;
	method: string;
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
): CdpFormDiscovery {
	const parentByBackendId = new Map<number, number | null>();
	const formsByBackendId = new Map<number, CdpFormCandidate>();
	const formsByHtmlId = new Map<string, CdpFormCandidate>();
	const fields: Array<{ node: CdpDomNode; tag: string }> = [];
	let shadowRootCount = 0;
	let closedShadowRootCount = 0;
	let nodeCount = 0;

	const visit = (node: CdpDomNode, parentBackendNodeId: number | null) => {
		nodeCount += 1;
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
				fields: [],
			};
			formsByBackendId.set(node.backendNodeId, form);
			if (attributes.id) formsByHtmlId.set(attributes.id, form);
		}
		if (FIELD_TAGS.has(tag) && fields.length < MAX_CANDIDATE_FIELDS) {
			fields.push({ node, tag });
		}

		for (const child of composedChildren(node)) {
			visit(child, node.backendNodeId);
		}
	};

	visit(root, null);

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
