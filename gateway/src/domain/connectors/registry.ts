/**
 * Connector Registry — Extensible adapter pattern.
 *
 * Each connector (Gmail, Calendar, Jira, etc.) registers itself here.
 * The registry holds metadata, scopes, and factory functions.
 * Adding a new integration = adding a new ConnectorDefinition; zero core changes.
 */

export interface ConnectorDefinition {
  /** Unique connector type key, e.g. 'gmail', 'google_calendar', 'jira' */
  type: string;
  /** Human-readable name */
  displayName: string;
  /** OAuth scopes required for this connector */
  scopes: string[];
  /** Category for UI grouping */
  category: 'email' | 'calendar' | 'project_management' | 'communication' | 'other';
  /** Whether this connector is currently enabled */
  enabled: boolean;
  /** Description for the user */
  description: string;
}

class ConnectorRegistry {
  private connectors = new Map<string, ConnectorDefinition>();

  register(definition: ConnectorDefinition): void {
    if (this.connectors.has(definition.type)) {
      throw new Error(`Connector '${definition.type}' is already registered`);
    }
    this.connectors.set(definition.type, definition);
  }

  get(type: string): ConnectorDefinition | undefined {
    return this.connectors.get(type);
  }

  getAll(): ConnectorDefinition[] {
    return Array.from(this.connectors.values());
  }

  getEnabled(): ConnectorDefinition[] {
    return this.getAll().filter((c) => c.enabled);
  }

  isRegistered(type: string): boolean {
    return this.connectors.has(type);
  }
}

// Singleton
export const connectorRegistry = new ConnectorRegistry();

// ===== Register built-in connectors =====

connectorRegistry.register({
  type: 'gmail',
  displayName: 'Gmail',
  scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  category: 'email',
  enabled: true,
  description: 'Read, draft, and send emails via Gmail',
});

// Future connectors — register here when ready:
// connectorRegistry.register({
//   type: 'google_calendar',
//   displayName: 'Google Calendar',
//   scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
//   category: 'calendar',
//   enabled: false,
//   description: 'Read calendar events for context-aware scheduling',
// });
