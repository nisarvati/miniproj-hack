## Core Product Principles

MedLink is a federated medicine search and discovery platform.
It is NOT an online pharmacy, a medicine-selling platform, or a
centralized pharmacy inventory management system.

The goal is to help users discover medicine availability across
independent pharmacies while allowing each pharmacy to retain
ownership and control of its local database.

All changes must preserve these principles:

- Each pharmacy's local database is authoritative for its inventory.
- Inventory changes must flow through the established synchronization
  pipeline.
- The central searchable state is a synchronized representation of
  pharmacy inventory, not a replacement for pharmacy-owned databases.
- Search must not depend on querying every pharmacy database.
- Pharmacy inventory must remain isolated by pharmacy identity.
- Services must communicate through established interfaces and event
  contracts rather than bypassing service boundaries.

Do not introduce architectural changes that violate these principles
without explicit approval.

## Architecture and Data Flow

The repository is a TypeScript npm workspaces monorepo.

The primary inventory synchronization flow is:

1. A pharmacy updates its local inventory database.
2. The database transaction records an inventory change in its
   transactional outbox.
3. The inventory connector reads pending outbox events.
4. The connector publishes events to Redis Streams, using the
   established per-pharmacy stream and Redis Cluster key conventions.
5. The inventory synchronization service consumes events.
6. The synchronization service deduplicates events and updates the
   current searchable inventory state in Redis.
7. The synchronization service mirrors inventory state to central
   PostgreSQL according to the existing fallback and persistence logic.
8. The search service combines the central medicine catalogue with
   current inventory availability to produce search results.
9. The notification service processes relevant inventory changes,
   including medicine restock notifications.

The exact implementation in the repository takes precedence over
this conceptual description. Inspect the existing code before changing
the pipeline.

### Service Responsibilities

- Web application:
  Provides the user-facing medicine search and discovery experience.

- Search API:
  Handles search requests, queries the established catalogue and
  availability sources, and applies existing ranking logic.

- Pharmacy portal:
  Allows authorized pharmacy users to manage their pharmacy's data.
  Inventory writes must go through the pharmacy's own database and
  the normal synchronization pipeline.

- Inventory connector:
  Reads pharmacy-local outbox events and publishes them to Redis
  Streams. It must not bypass the outbox or silently discard events.

- Inventory synchronization service:
  Consumes inventory events, handles deduplication, updates searchable
  inventory state, and maintains the established PostgreSQL mirror
  behavior.

- Notification service:
  Handles inventory-related notifications, including restock events.
  Notification processing must not compromise inventory correctness.

- Simulator:
  Supports development and testing of pharmacy nodes and inventory
  synchronization behavior.

- Shared packages:
  Contain reusable database utilities, event schemas, Redis utilities,
  types, configuration, and pharmacy operations as appropriate.

Do not move responsibilities between services without explicit approval.

## Architectural Invariants

The following rules must be preserved unless a change is explicitly
approved.

### Pharmacy Data Ownership

- A pharmacy's local database remains authoritative for its inventory.
- The pharmacy portal must not directly modify Redis search state.
- The pharmacy portal must not bypass the transactional outbox.
- Inventory updates must use the normal event-driven pipeline.
- Centralized search infrastructure must not become a replacement
  for pharmacy-local inventory databases.

### Event Processing

- Preserve the existing event schema and versioning conventions.
- Inventory events must have stable identifiers suitable for
  deduplication.
- Event processing must be idempotent wherever retries can occur.
- Retried or duplicate events must not corrupt inventory state.
- Preserve the existing ordering guarantees and event version checks.
- Handle malformed events explicitly rather than silently ignoring them.
- Do not acknowledge or discard an event before the required processing
  and recovery guarantees are satisfied.
- Preserve retry, failure handling, and dead-letter behavior where
  implemented.

### Redis and PostgreSQL

- Redis Streams is the event delivery and processing mechanism.
- Redis stores the current searchable inventory state.
- Central PostgreSQL stores the medicine catalogue and the inventory
  mirror according to the existing schema and persistence design.
- The PostgreSQL mirror must not silently become a competing
  authoritative inventory source.
- Preserve the existing Redis Cluster compatibility requirements.
- Follow existing Redis key conventions, including per-pharmacy
  hash tags where required for cluster slot compatibility.
- Do not assume that multi-key Redis operations work across different
  cluster slots.
- Redis failures must not silently cause inventory updates to be lost.
- Preserve the established recovery and reconciliation behavior.

### Consistency

- Inventory synchronization is eventually consistent.
- Do not claim that a pharmacy's local update is instantly visible
  in every search result.
- Preserve existing safeguards against stale events overwriting
  newer inventory state.
- Maintain a clear distinction between unavailable inventory data,
  zero stock, and unknown stock.
- Do not report successful synchronization unless the relevant
  operation has actually succeeded.

## Development Workflow

Before modifying code:

1. Inspect the repository structure and relevant workspace.
2. Read any applicable AGENTS.md files in parent and child directories.
3. Identify the existing implementation, interfaces, and tests.
4. Trace the affected data flow across service boundaries.
5. Determine whether the change affects event schemas, database
   migrations, Redis keys, API contracts, or environment variables.
6. Prefer the smallest change that correctly solves the problem.

Do not assume that a feature is missing just because it is not
immediately visible. Search the existing implementation first.

Do not rewrite working subsystems simply to introduce a preferred
design or technology.

For significant architectural changes, explain the proposed approach,
affected components, risks, and testing plan before implementation.

Implement approved work incrementally and keep changes scoped to the
requested task.

## Repository and Git Safety

- Do not commit or push changes unless explicitly instructed.
- Do not amend commits, reset branches, force-push, or rewrite Git history.
- Never discard uncommitted user changes.
- Inspect git status before making modifications.
- Do not overwrite existing implementation or configuration blindly.
- Do not modify unrelated files to make a task appear complete.
- Do not stop, restart, or reconfigure existing development servers
  without explicit authorization.
- Avoid interfering with services already running on ports 3000 and 4000.
- Report modified files and important implementation decisions clearly.

## Testing and Validation

For every behavior change:

- Add or update focused tests.
- Test normal operation and relevant failure scenarios.
- Test duplicate event delivery when modifying event processing.
- Test stale or out-of-order events when modifying inventory updates.
- Test Redis failure and recovery behavior when modifying persistence
  or synchronization logic.
- Test pharmacy isolation when modifying pharmacy-specific operations.
- Test Redis Cluster compatibility when changing keys or multi-key
  operations.
- Test API behavior and response contracts when modifying search.

Run the relevant workspace tests first, followed by broader checks
as appropriate.

Use the repository's existing commands for:

- Unit and integration tests
- Redis Cluster tests
- TypeScript type checking
- Linting
- Production builds

If a check cannot run, explain why. Never report a test as passing
unless it actually ran successfully.

Do not weaken, skip, or delete existing tests merely to make the
test suite pass.

## Database and Migration Safety

- Inspect existing schemas and migrations before changing the database.
- Do not modify an existing migration in a way that breaks environments
  where it has already been applied.
- Add a new migration for schema changes when required by the project's
  migration conventions.
- Preserve transaction boundaries for inventory changes and outbox
  event creation.
- Ensure inventory updates and their corresponding outbox events
  remain atomic where the architecture requires it.
- Avoid destructive migrations unless explicitly approved.
- Document any required migration or data backfill.

## API and Event Contract Safety

- Treat shared types, API response shapes, and event schemas as
  contracts between independently deployed or developed services.
- Update producers, consumers, and tests together when changing
  a shared event contract.
- Preserve backward compatibility where required.
- Validate external input at service boundaries.
- Avoid introducing undocumented fields or changing field meanings
  without updating the relevant consumers and documentation.
- Keep environment configuration and defaults consistent across
  affected workspaces.

## Security and Privacy

- Never hardcode API keys, passwords, database credentials, or tokens.
- Use environment variables and document required configuration
  through .env.example.
- Never commit real secrets or production data.
- Validate and authorize pharmacy-specific operations on the server.
- Do not trust a pharmacy identifier supplied by a client without
  verifying that the authenticated user can access that pharmacy.
- Prevent cross-pharmacy data access and unauthorized inventory changes.
- Avoid logging credentials, access tokens, or sensitive user data.
- Use parameterized database queries and validate untrusted input.

## Documentation

Update relevant documentation when a change affects:

- Architecture or service responsibilities
- API contracts or event schemas
- Database schemas or migrations
- Redis keys or cluster behavior
- Environment variables or local setup
- Failure recovery or operational procedures
- Testing and development commands

Keep documentation consistent with the implementation. Do not document
planned behavior as though it has already been implemented.