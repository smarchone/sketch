# Ride-Hailing Dispatch

```
Rider  —requests→ Trip —becomes→ Offer —accepted by→ Driver
Driver —streams→  Location —feeds→ Supply index —ranks→ Candidates
```

- **Rider**: whoever requests a Trip
- **Driver**: who serves a Trip; online or offline
- **Trip**: one pickup → dropoff journey for a Rider
- **Location**: a Driver's GPS ping, every ~4s
- **Supply index**: live geo-index of available Drivers by cell
- **Candidates**: nearby available Drivers ranked by ETA
- **Offer**: a time-boxed proposal of a Trip to one Driver
- **Match**: an accepted Offer binding a Driver to a Trip
- **Dispatch**: the loop from Trip request to Match
