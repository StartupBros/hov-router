import { useHealth } from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { describeSystemStatus } from "./system-status/describeSystemStatus";
import { RecentErrorsCard } from "./system-status/RecentErrorsCard";
import { SystemStatusBanner } from "./system-status/SystemStatusBanner";

export function SystemStatus() {
	const { data: health } = useHealth();
	return (
		<Card>
			<CardHeader>
				<CardTitle>System Status</CardTitle>
				<CardDescription>
					Current operational status and recent events
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					<SystemStatusBanner view={describeSystemStatus(health)} />
					<RecentErrorsCard />
				</div>
			</CardContent>
		</Card>
	);
}
