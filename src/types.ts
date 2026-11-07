// ============================================================================
// HomePulse Frontend TypeScript Definitions (src/types.ts)
// ============================================================================

interface TelemetryEntity {
  node_id: string;
  entity_key: string;
  name?: string;
  type?: 'sensor' | 'binary_sensor' | 'control' | 'value' | string;
  value_type?: 'float' | 'string' | 'boolean' | string;
  unit?: string;
  value?: any;
  status?: string;
  status_type?: 'optimal' | 'stable' | 'healthy' | 'warning' | 'caution' | 'alarm' | 'error' | 'critical' | 'default' | string;
  tags?: string;
  icon?: string;
  color?: string;
  graphic?: string;
  plugin_id?: string;
  range?: [number, number] | number[];
  attributes?: Record<string, any>;
  [key: string]: any;
}

interface WidgetEntityRef {
  nodeId: string;
  entityKey: string;
}

interface DashboardWidgetOptions {
  unit?: string;
  min?: number;
  max?: number;
  color?: string;
  icon?: string;
  graphic?: string;
  gridWidth?: number;
  gridHeight?: number;
  subtitle?: string;
  align?: string;
  [key: string]: any;
}

interface DashboardWidget {
  id: string;
  type: 'sensor' | 'control' | 'value' | 'gauge' | 'title' | 'entities' | 'glance' | 'health' | 'audit' | 'error' | string;
  title: string;
  tab?: string;
  entity?: string;
  entities?: Array<WidgetEntityRef | string>;
  options: DashboardWidgetOptions;
  errorMessage?: string;
}

interface DashboardTab {
  id: string;
  name: string;
}

interface HostNode {
  id: number;
  name: string;
  target: string;
  target_internal?: string;
  target_external?: string | null;
  ping_enabled: boolean;
  ping_target?: string;
  http_enabled: boolean;
  http_target?: string;
  https_enabled: boolean;
  https_target?: string;
  ssl_enabled: boolean;
  ssl_target?: string;
  port_enabled: boolean;
  port_target?: string;
  port_number?: number | null;
  polling_interval: number;
}

interface ServiceMonitor {
  id: number;
  name: string;
  type: 'http' | 'https' | 'ping' | 'port' | 'dns' | 'websocket' | 'ssl' | string;
  target: string;
  check_interval: number;
  timeout: number;
  last_status?: string;
  last_latency?: number | null;
  last_checked?: string | null;
  enabled: boolean;
  host_id?: number | null;
  category?: string;
  group_ids?: number[];
}

interface AlertCondition {
  entity_key: string;
  operator: '==' | '!=' | '>' | '<' | 'contains' | string;
  value: string;
  join_type: 'AND' | 'OR' | '';
}

interface AlertRule {
  id: number;
  name: string;
  rules_json: AlertCondition[];
  channel_ids: number[];
  enabled: boolean;
  status?: string;
  last_fired?: string | null;
  target_type?: string;
  monitors_list?: number[];
  target_groups?: number[];
  target_groups_operator?: string;
  targets_list?: string[];
  cooldown_interval?: string;
}

interface NotificationChannel {
  id: number;
  name: string;
  type: 'smtp' | 'telegram' | 'pushover' | 'webhook' | 'discord' | 'slack' | string;
  config: Record<string, any>;
}

interface PluginSettingSchema {
  type: 'string' | 'password' | 'integer' | 'boolean' | string;
  label?: string;
  default?: any;
  required?: boolean;
}

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  status?: 'running' | 'stopped' | 'crashed' | string;
  has_readme?: boolean;
  readme_url?: string;
  settings_schema?: Record<string, PluginSettingSchema>;
  config?: Record<string, any>;
  entities?: Record<string, any>;
}

interface FlowNode {
  id: string;
  type: 'monitor_trigger' | 'sensor_trigger' | 'condition' | 'logic_gate' | 'cooldown' | 'notify' | string;
  x: number;
  y: number;
  name?: string;
  config?: Record<string, any>;
  data?: Record<string, any>;
  [key: string]: any;
}

interface FlowEdge {
  id?: string;
  source?: string;
  target?: string;
  from?: string;
  to?: string;
  [key: string]: any;
}

// External / Global vendor libraries & Window bindings
declare var jsyaml: any;
declare var lucide: any;
declare var Chart: any;

// Global functions and state attached via window.* across modules
declare var isEditMode: boolean;
declare var showConfirm: (message: string, title?: string) => Promise<boolean>;
declare var showAlert: (message: string, title?: string, type?: string) => any;
declare var loadFlowsList: () => Promise<void>;
declare var switchAlertRouterTab: (subTab: string) => void;
declare var showLayoutView: () => void;
declare var openAddMonitorModal: () => void;
declare var openMarketplaceModal: () => void;
declare var updateGatewayUIVisibilities: () => void;
declare var clearPruneFilters: () => void;
declare var onCustomDateRangeChanged: () => void;
declare var shiftHistoryTimeWindow: (direction: number) => void;
declare var toggleHostPollingInterval: (mode: any) => void;
declare var editHostFromDetail: () => void;
declare var openEditHostModal: (hostId: number) => void;
declare var switchPluginTab: (tab: string) => void;
declare var openModal: (modalId: string) => void;
declare var closeModal: (modalId: string) => void;
declare var loadApiKeysList: () => Promise<void>;
declare var openHistoryCombobox: () => void;
declare var closeHistoryCombobox: () => void;
declare var toggleHistoryCombobox: () => void;
declare var selectHistoryComboboxOption: (val: string, isCustom?: boolean) => void;
declare var applyHistoryPreset: (preset: string, triggerLoad?: boolean) => void;
declare var refreshPluginLogs: () => Promise<void>;
declare var flowDragNode: any;
declare var flowConnectingSourcePort: any;
declare var flowNodes: FlowNode[];
declare var flowEdges: FlowEdge[];
declare var selectedNodeId: string | null;
declare var activeFlowProfileId: number | null;
declare var flowCachedMonitors: any[];
declare var flowCachedPlugins: any[];

// Ergonomic DOM element augmentations for dynamic form & SVG elements
interface HTMLElement {
  value?: any;
  checked?: boolean;
  disabled?: boolean;
  open?: boolean;
  type?: string;
  options?: any;
  selectedOptions?: any;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectedIndex?: number;
  files?: FileList | null;
  select?: () => void;
  getContext?: (contextId: string) => any;
  setSelectionRange?: (start: number, end: number) => void;
}

interface Element {
  style?: CSSStyleDeclaration;
  value?: any;
  checked?: boolean;
  disabled?: boolean;
  open?: boolean;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  dataset?: DOMStringMap;
  innerText?: string;
  onclick?: ((this: GlobalEventHandlers, ev: MouseEvent) => any) | null;
  click?: () => void;
  focus?: () => void;
}

interface EventTarget {
  value?: any;
  checked?: boolean;
  files?: FileList | null;
  classList?: DOMTokenList;
  dataset?: DOMStringMap;
  style?: CSSStyleDeclaration;
  closest?: (selector: string) => Element | null;
  getBoundingClientRect?: () => DOMRect;
  getAttribute?: (qualifiedName: string) => string | null;
}

interface CSSStyleDeclaration {
  webkitTextSecurity?: string;
  [key: string]: any;
}

interface Window {
  [key: string]: any;
}
