-- Active Nodes Table
CREATE TABLE IF NOT EXISTS nodes (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    version VARCHAR(32),
    hardware_model VARCHAR(128),
    mac_address VARCHAR(17),
    status VARCHAR(32) DEFAULT 'pending',
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Active Entities (Sensors/Controls)
CREATE TABLE IF NOT EXISTS entities (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(64) REFERENCES nodes(id) ON DELETE CASCADE,
    entity_key VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL, -- 'sensor' or 'control'
    value_type VARCHAR(32) NOT NULL,
    unit VARCHAR(16),
    UNIQUE (node_id, entity_key)
);

-- High-Frequency Telemetry Log
CREATE TABLE IF NOT EXISTS telemetry_logs (
    id BIGSERIAL PRIMARY KEY,
    node_id VARCHAR(64) NOT NULL,
    entity_key VARCHAR(64) NOT NULL,
    value VARCHAR(255) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_telemetry_time ON telemetry_logs (node_id, entity_key, timestamp DESC);

-- System Audits Log
CREATE TABLE IF NOT EXISTS system_audits (
    id SERIAL PRIMARY KEY,
    type VARCHAR(32) NOT NULL, -- 'info', 'success', 'warning', 'error'
    message TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- System Settings Key-Value Registry
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(64) PRIMARY KEY,
    value VARCHAR(255) NOT NULL
);

INSERT INTO system_settings (key, value) VALUES 
('telemetry_interval', '3'),
('log_retention', '7'),
('timezone', 'UTC'),
('preshared_key', 'device_pin_12345'),
('theme', 'midnight'),
('layout_compact', 'false')
ON CONFLICT (key) DO NOTHING;

-- Built-in Service and Network Monitors
CREATE TABLE IF NOT EXISTS system_monitors (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL, -- 'http', 'websocket', 'ping', 'port', 'dns'
    target VARCHAR(255) NOT NULL,
    check_interval INT DEFAULT 30, -- seconds
    timeout INT DEFAULT 5, -- seconds
    last_status VARCHAR(32) DEFAULT 'unknown',
    last_latency FLOAT,
    last_checked TIMESTAMP,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

