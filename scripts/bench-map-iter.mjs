// Estimate the upper bound on what we can save by switching Map->Array iteration.
// Compares (a) pure Map.values() for-of overhead with empty body, (b) flat array
// for(let i...) overhead, against the realistic case where body work dominates.

const N = 290;
const map = new Map();
const arr = [];
for (let i = 0; i < N; i++) {
  const obj = { id: `e${i}`, x: i, y: i * 2, hp: 100, _numericId: i };
  map.set(obj.id, obj);
  arr.push(obj);
}

const ITER = 200_000;

// Empty body: pure iteration cost
let t0 = performance.now();
let sink = 0;
for (let r = 0; r < ITER; r++) {
  for (const e of map.values()) sink += e.x;
}
const mapEmpty = performance.now() - t0;

t0 = performance.now();
sink = 0;
for (let r = 0; r < ITER; r++) {
  for (let i = 0; i < arr.length; i++) sink += arr[i].x;
}
const arrEmpty = performance.now() - t0;

// Realistic body: simulate a small chunk of physics/distance work
const px = 100, py = 100;
function work(e) {
  const dx = e.x - px;
  const dy = e.y - py;
  const d2 = dx * dx + dy * dy;
  e.x += dx / (d2 + 1) * 0.01;
  e.y += dy / (d2 + 1) * 0.01;
  return d2;
}

t0 = performance.now();
sink = 0;
for (let r = 0; r < ITER; r++) {
  for (const e of map.values()) sink += work(e);
}
const mapBody = performance.now() - t0;

t0 = performance.now();
sink = 0;
for (let r = 0; r < ITER; r++) {
  for (let i = 0; i < arr.length; i++) sink += work(arr[i]);
}
const arrBody = performance.now() - t0;

console.log(`Empty body:  Map=${mapEmpty.toFixed(1)}ms  Array=${arrEmpty.toFixed(1)}ms  delta=${(mapEmpty - arrEmpty).toFixed(1)}ms (${((1 - arrEmpty/mapEmpty)*100).toFixed(1)}% saved)`);
console.log(`With body:   Map=${mapBody.toFixed(1)}ms  Array=${arrBody.toFixed(1)}ms  delta=${(mapBody - arrBody).toFixed(1)}ms (${((1 - arrBody/mapBody)*100).toFixed(1)}% saved)`);
console.log(`Per-frame upper bound (1 loop, 290 enemies): ${((mapBody-arrBody)/ITER*1000).toFixed(2)}us`);
console.log(`(sink=${sink})`);
