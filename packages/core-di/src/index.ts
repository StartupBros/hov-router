import { container as _container } from "./container";

export const container = _container;

// Service keys - using symbols for better encapsulation
export const SERVICE_KEYS = {
	Logger: Symbol("Logger"),
	Config: Symbol("Config"),
	Database: Symbol("Database"),
	PricingLogger: Symbol("PricingLogger"),
	AsyncWriter: Symbol("AsyncWriter"),
} as const;
