# HomePulse

HomePulse is a community-focused, highly modular monitoring system designed to handle real-time telemetry from custom local hardware and microcontrollers. It features a modern, responsive user experience inspired by Home Assistant's Lovelace UI.

## Core Features

- **Modular Architecture & Dynamic Endpoints**: No hardcoded devices or features. Capabilities are defined dynamically via JSON schemas/manifests provided by the endpoints, with the dashboard dynamically generating UI controls.
- **Push-Based Communication**: Active push model (WebSockets or HTTP POST) from endpoints to the server for instant status updates and sub-second feedback loops.
- **Dynamic mDNS Node Discovery**: Automatic discovery of new endpoints on the local network. Discovered nodes are put in a pending queue for secure manual administrator approval (using pre-shared keys or PINs) before integration.
- **Role-Based Access Control (RBAC)**: Support for Observer (read-only), Controller (dashboard/control edits), and Architect (full administration/node approval) roles.
- **Docker-Ready**: Multi-container architecture (`docker-compose`) with PostgreSQL for event and telemetry logging.
