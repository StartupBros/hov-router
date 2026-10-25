import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import { HttpError } from "@better-ccflare/http-common";
import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { AccountsTab } from "./components/AccountsTab";
import { AgentsTab } from "./components/AgentsTab";
import { ApiKeyAuthDialog } from "./components/ApiKeyAuthDialog";
import { ApiKeysTab } from "./components/ApiKeysTab";
import { DeviceSetupJobCoordinator } from "./components/accounts/DeviceSetupJobCoordinator";
import { CombosTab } from "./components/combos/CombosTab";
import { DebugPanel } from "./components/DebugPanel";
import { LogsTab } from "./components/LogsTab";
import { Navigation } from "./components/navigation";
import { OverviewTab } from "./components/OverviewTab";
import { RequestsTab } from "./components/RequestsTab";
import { SettingsTab } from "./components/SettingsTab";
import {
	RouterUnreachableView,
	StartupCheckingView,
} from "./components/StartupStatus";
import { QUERY_CONFIG, REFRESH_INTERVALS } from "./constants";
import { ThemeProvider } from "./contexts/theme-context";
import {
	authenticateErrorMessage,
	isKeyRejection,
	runStartupCheck,
	STARTUP_SLOW_NOTICE_MS,
	startupRetryDelayMs,
} from "./lib/startup-check";
import "./index.css";

// Lazy load heavy components for better bundle splitting
const LazyAnalyticsTab = lazy(() =>
	import("./components/LazyAnalytics").then((module) => ({
		default: module.LazyAnalytics,
	})),
);
const LazyInsightsTab = lazy(() =>
	import("./components/InsightsTab").then((module) => ({
		default: module.InsightsTab,
	})),
);
const LazyUsageHistoryTab = lazy(() =>
	import("./components/usage-history/UsageHistoryTab").then((m) => ({
		default: m.UsageHistoryTab,
	})),
);
const LazyWindowValueTab = lazy(() =>
	import("./components/window-value/WindowValueTab").then((m) => ({
		default: m.WindowValueTab,
	})),
);
const LoadingSkeleton = () => (
	<div className="space-y-6 p-6">
		<div className="animate-pulse">
			<div className="h-8 bg-muted rounded w-32 mb-4"></div>
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				{Array.from({ length: 4 }, (_, i) => `skeleton-card-${i}`).map(
					(key) => (
						<div key={key} className="h-24 bg-muted rounded" />
					),
				)}
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{Array.from({ length: 2 }, (_, i) => `skeleton-chart-${i}`).map(
					(key) => (
						<div key={key} className="h-64 bg-muted rounded" />
					),
				)}
			</div>
		</div>
	</div>
);

// QueryClient will be created inside App component to have access to auth state

export function App() {
	const location = useLocation();
	// Build the dashboard routes once; released features remain reachable.
	const routes = useMemo(() => {
		const baseRoutes = [
			{
				path: "/",
				element: <OverviewTab />,
				title: "Dashboard Overview",
				subtitle: `Monitor your ${PRODUCT_NAME} performance and usage`,
			},
			{
				path: "/analytics",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyAnalyticsTab />
					</Suspense>
				),
				title: "Analytics",
				subtitle: "Deep dive into your usage patterns and trends",
			},
			{
				path: "/insights",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyInsightsTab />
					</Suspense>
				),
				title: "Insights",
				subtitle: "Cache efficiency and estimated cost savings",
			},
			{
				path: "/requests",
				element: <RequestsTab />,
				title: "Request History",
				subtitle: "View detailed request and response data",
			},
			{
				path: "/accounts",
				element: <AccountsTab />,
				title: "Account Management",
				subtitle: "Manage your OAuth accounts and settings",
			},
			{
				path: "/usage-history",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyUsageHistoryTab />
					</Suspense>
				),
				title: "Usage History",
				subtitle: "Per-account usage windows over time, with limit prediction",
			},
			{
				path: "/window-value",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyWindowValueTab />
					</Suspense>
				),
				title: "Window Value",
				subtitle: "Track the value of active and completed usage windows",
			},
			{
				path: "/agents",
				element: <AgentsTab />,
				title: "Agent Management",
				subtitle: "Discover and manage Claude Code agents",
			},
			{
				path: "/api-keys",
				element: <ApiKeysTab />,
				title: "API Key Management",
				subtitle: "Generate and manage API keys for authentication",
			},
			{
				path: "/logs",
				element: <LogsTab />,
				title: "System Logs",
				subtitle: "Real-time system logs and debugging information",
			},
			{
				path: "/settings",
				element: <SettingsTab />,
				title: "Settings",
				subtitle: "Configure system behavior and data retention",
			},
		];

		baseRoutes.splice(5, 0, {
			path: "/combos",
			element: <CombosTab />,
			title: "Combos Management",
			subtitle: "Define fallback chains for model families",
		});

		return baseRoutes;
	}, []);

	const currentRoute =
		routes.find((route) => route.path === location.pathname) || routes[0];
	const [showAuthDialog, setShowAuthDialog] = useState(false);
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	// "unreachable" means the startup request got no answer from the router;
	// the check keeps retrying until it does.
	const [startup, setStartup] = useState<
		| { phase: "checking" }
		| { phase: "unreachable"; message: string; retrying: boolean }
		| { phase: "done" }
	>({ phase: "checking" });
	const [slowCheck, setSlowCheck] = useState(false);
	const [checkRun, setCheckRun] = useState(0);
	const startupFailuresRef = useRef(0);
	const isCheckingAuth = startup.phase !== "done";
	const [authError, setAuthError] = useState<string | null>(null);
	const [authRequired, setAuthRequired] = useState(false);

	// Use refs to store state setters so they can be accessed in QueryClient callbacks
	const showAuthDialogRef = useRef(setShowAuthDialog);
	const isAuthenticatedRef = useRef(setIsAuthenticated);
	const authErrorRef = useRef(setAuthError);
	const authRequiredRef = useRef(setAuthRequired);

	// Update refs when setters change
	useEffect(() => {
		showAuthDialogRef.current = setShowAuthDialog;
		isAuthenticatedRef.current = setIsAuthenticated;
		authErrorRef.current = setAuthError;
		authRequiredRef.current = setAuthRequired;
	}, []);

	// Create QueryClient with global error handler for 401 errors
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchInterval: REFRESH_INTERVALS.default,
						staleTime: QUERY_CONFIG.staleTime,
						retry: (failureCount, error) => {
							// Don't retry on 401 errors
							if (error instanceof HttpError && error.status === 401) {
								return false;
							}
							return failureCount < 2;
						},
					},
					mutations: {
						retry: false,
					},
				},
				queryCache: new QueryCache({
					onError: (error) => {
						// Show auth dialog on any 401 error
						if (error instanceof HttpError && error.status === 401) {
							console.log("[App] 401 error in query - showing auth dialog");
							api.clearApiKey();
							authErrorRef.current(null); // Clear any previous errors
							isAuthenticatedRef.current(false);
							authRequiredRef.current(true);
							showAuthDialogRef.current(true);
						}
					},
				}),
				mutationCache: new MutationCache({
					onError: (error) => {
						// Show auth dialog on any 401 error
						if (error instanceof HttpError && error.status === 401) {
							console.log("[App] 401 error in mutation - showing auth dialog");
							api.clearApiKey();
							authErrorRef.current(null); // Clear any previous errors
							isAuthenticatedRef.current(false);
							authRequiredRef.current(true);
							showAuthDialogRef.current(true);
						}
					},
				}),
			}),
		[],
	);

	useEffect(() => {
		const timer = setTimeout(() => setSlowCheck(true), STARTUP_SLOW_NOTICE_MS);
		return () => clearTimeout(timer);
	}, []);

	// Check if authentication is required. Always verify with a test request,
	// even with a stored key: the key might be invalid, deleted, or expired.
	// biome-ignore lint/correctness/useExhaustiveDependencies: each change of checkRun starts one attempt
	useEffect(() => {
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		setStartup((current) =>
			current.phase === "unreachable"
				? { ...current, retrying: true }
				: current,
		);
		void runStartupCheck(
			() => api.getStats(),
			() => api.hasApiKey(),
		).then((outcome) => {
			if (cancelled) return;
			if (outcome.kind === "unreachable") {
				// No answer, e.g. while a deploy swaps the backend and the guard
				// holds new requests. Say so and retry, never show an empty page.
				const delay = startupRetryDelayMs(startupFailuresRef.current);
				startupFailuresRef.current += 1;
				setStartup({
					phase: "unreachable",
					message: outcome.message,
					retrying: false,
				});
				retryTimer = setTimeout(() => setCheckRun((run) => run + 1), delay);
				return;
			}
			startupFailuresRef.current = 0;
			if (outcome.kind === "ready") {
				setIsAuthenticated(true);
				// Auth is required only if we got here with a stored key
				setAuthRequired(outcome.authRequired);
			} else {
				// Clear the rejected stored key
				api.clearApiKey();
				setAuthError(outcome.message);
				setAuthRequired(true);
				setShowAuthDialog(true);
			}
			setStartup({ phase: "done" });
		});
		return () => {
			cancelled = true;
			clearTimeout(retryTimer);
		};
	}, [checkRun]);

	// Listen for 401 errors from API client
	useEffect(() => {
		const handleAuthRequired = () => {
			api.clearApiKey();
			setAuthError(null);
			setIsAuthenticated(false);
			setAuthRequired(true);
			setShowAuthDialog(true);
		};

		window.addEventListener("auth-required", handleAuthRequired);
		return () =>
			window.removeEventListener("auth-required", handleAuthRequired);
	}, []);

	const handleAuthenticate = async (apiKey: string): Promise<boolean> => {
		setAuthError(null);

		// Store the API key
		api.setApiKey(apiKey);

		// Try to make a request to verify the key
		try {
			await api.getStats();
			setIsAuthenticated(true);
			setShowAuthDialog(false);
			return true;
		} catch (error) {
			// Clear the key only when the router rejected it; a timeout or 5xx
			// says nothing about the key.
			if (isKeyRejection(error)) api.clearApiKey();
			setAuthError(authenticateErrorMessage(error));
			return false;
		}
	};

	const handleLogout = () => {
		api.clearApiKey();
		setIsAuthenticated(false);
		setShowAuthDialog(true);
	};

	// Show loading state while checking authentication
	if (startup.phase === "checking") {
		return (
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					<StartupCheckingView slow={slowCheck} />
				</ThemeProvider>
			</QueryClientProvider>
		);
	}

	if (startup.phase === "unreachable") {
		return (
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					<RouterUnreachableView
						message={startup.message}
						retrying={startup.retrying}
						onRetry={() => setCheckRun((run) => run + 1)}
					/>
				</ThemeProvider>
			</QueryClientProvider>
		);
	}

	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<DeviceSetupJobCoordinator authenticated={isAuthenticated} />
				<div className="min-h-screen bg-background">
					<Navigation onLogout={authRequired ? handleLogout : undefined} />

					{/* Main Content */}
					<main className="lg:pl-64">
						{/* Mobile spacer */}
						<div className="h-16 lg:hidden" />

						{/* Page Content */}
						<div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto">
							{/* Page Header */}
							<div className="mb-8">
								<h1 className="text-3xl font-bold gradient-text">
									{currentRoute.title}
								</h1>
								<p className="text-muted-foreground mt-2">
									{currentRoute.subtitle}
								</p>
							</div>

							{/* Tab Content - Only render if auth check is complete and user is authenticated */}
							{!isCheckingAuth && isAuthenticated && (
								<div className="animate-in fade-in-0 duration-200">
									<Routes>
										{routes.map((route) => (
											<Route
												key={route.path}
												path={route.path}
												element={route.element}
											/>
										))}
										<Route path="*" element={<Navigate to="/" replace />} />
									</Routes>
								</div>
							)}
						</div>
					</main>
				</div>
				<DebugPanel />

				{/* API Key Authentication Dialog */}
				<ApiKeyAuthDialog
					isOpen={showAuthDialog}
					onAuthenticate={handleAuthenticate}
					error={authError}
				/>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
