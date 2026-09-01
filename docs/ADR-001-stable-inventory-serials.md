# ADR-001: Permanent inventory identity and atomic serial allocation

**Status:** Accepted  
**Date:** 2026-08-25  
**Deciders:** Seshat product owner and implementation team

## Context

Seshat originally inferred serial ownership from normalized governorate and storehouse text. That allowed a later page to continue a sequence, but names can be edited, duplicated, or entered differently. Calculating the next number in React state also allowed two browser tabs to observe the same next value before either saved.

## Decision

IndexedDB version 2 adds an `inventories` object store. Every inventory has an immutable UUID, legacy lookup key, preserved serial prefix, and `nextSerial` counter. Every run records `manifest.inventory_id`.

Missing serials are allocated and the run is saved in one read/write transaction spanning the `inventories` and `runs` stores. IndexedDB serializes competing write transactions, so a later tab observes the advanced counter. Issued numbers are never released when a run is deleted.

Existing version-1 runs are linked to generated inventory UUIDs on first load. Valid serials are retained and each counter is initialized above the highest issued number.

## Options considered

### Continue deriving identity from names

- Low implementation effort.
- Unsafe across renames, duplicated labels, and concurrent tabs.

### Store a counter in localStorage

- Simple, but updates are not transactional with IndexedDB run storage.
- Cross-tab races can still issue duplicates.

### Inventory records and an IndexedDB transaction — chosen

- Stable identity and atomic local writes with no new service dependency.
- Requires a schema migration and explicit inventory selection at intake.

## Consequences

- Inventory UUIDs, not names, own serial history.
- Intake can explicitly continue an existing inventory.
- Renaming descriptive metadata cannot move already-linked runs.
- Deleting a run creates a deliberate serial gap; numbers are not reused.
- A future shared multi-user deployment must move this invariant to a server database transaction.

