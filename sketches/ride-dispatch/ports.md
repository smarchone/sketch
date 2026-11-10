### Ports

```ts
interface SupplyIndex {
  upsert(d: DriverId, at: Location, status: DriverStatus): void
  nearby(at: Location, radiusM: number): DriverId[]
}
interface EtaService {
  rank(pickup: Location, drivers: DriverId[]): Candidate[]
}
interface DriverChannel {
  sendOffer(o: Offer): void   // reply arrives as accept / decline
}
interface TripRepo {
  save(t: Trip, expectedVersion: number): void // CAS
}
```

*Access pattern:* `nearby()` runs per **Dispatch**, millions of `upsert()`/s — so the **Supply index** stays in memory, sharded by geo cell.
