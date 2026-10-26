/** Release authority only. Import directly; the core runtime barrel does not need it. */
export const ROUTER_REPOSITORY_ID = 1278801682;
export const ROUTER_OWNER = "StartupBros";
// GitHub reports the current name for this ID, so the name used before the
// 2026-10-21 rename (StartupBros/wstack-router) is not an authority.
export const ROUTER_REPOSITORIES = ["StartupBros/hov-router"] as const;
export type RouterRepositoryName = (typeof ROUTER_REPOSITORIES)[number];

export function isRouterRepository(
	name: unknown,
): name is RouterRepositoryName {
	return ROUTER_REPOSITORIES.some((repository) => repository === name);
}

/** Offline builds prove an exact origin and tagged source, not remote repository ID. */
export function routerRepositoryOrigins(name: string): readonly string[] {
	if (!isRouterRepository(name)) throw new Error("Wrong Router repository");
	return [
		`https://github.com/${name}`,
		`https://github.com/${name}.git`,
		`git@github.com:${name}.git`,
		`ssh://git@github.com/${name}.git`,
	];
}

/** The one release published under the former name; download verification only. */
export const HISTORICAL_WSTACK_RELEASE = Object.freeze({
	repository: "StartupBros/wstack-router",
	version: "3.6.2",
	ref: "refs/tags/v3.6.2",
	sha: "5d7b2a888a9b61d87916332b414e46606498d896",
} as const);

export function isHistoricalWstackRelease(identity: {
	readonly repository?: string;
	readonly version: string;
	readonly ref?: string;
	readonly sha?: string;
}): boolean {
	return (
		identity.repository === HISTORICAL_WSTACK_RELEASE.repository &&
		identity.version === HISTORICAL_WSTACK_RELEASE.version &&
		identity.ref === HISTORICAL_WSTACK_RELEASE.ref &&
		identity.sha === HISTORICAL_WSTACK_RELEASE.sha
	);
}

export interface RouterRepository {
	id: typeof ROUTER_REPOSITORY_ID;
	full_name: RouterRepositoryName;
	name: "hov-router";
	owner: { login: typeof ROUTER_OWNER };
}

/** API/event metadata must prove the stable numeric ID and all exact name fields. */
export function validateRouterRepository(metadata: unknown): RouterRepository {
	const repository = metadata as Partial<RouterRepository> | null | undefined;
	if (
		repository?.id !== ROUTER_REPOSITORY_ID ||
		!isRouterRepository(repository.full_name) ||
		repository.owner?.login !== ROUTER_OWNER ||
		typeof repository.name !== "string" ||
		`${repository.owner.login}/${repository.name}` !== repository.full_name
	)
		throw new Error("Wrong Router repository identity (owner/name/numeric ID)");
	return repository as RouterRepository;
}
