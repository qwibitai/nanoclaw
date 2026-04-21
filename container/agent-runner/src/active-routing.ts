import type { RoutingContext } from './formatter.js';

let _activeRouting: RoutingContext | null = null;

export function setActiveRouting(routing: RoutingContext): void {
  _activeRouting = routing;
}

export function getActiveRouting(): RoutingContext | null {
  return _activeRouting;
}
