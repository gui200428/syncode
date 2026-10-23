/** Deterministic PRNG (mulberry32) so failing fuzz runs are reproducible. */
export function rng(seed: number, alphabet = 'abcxyz \n\t{}é😀') {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * max);
  const str = (maxLen: number) => {
    let s = '';
    const n = int(maxLen + 1);
    for (let i = 0; i < n; i++) s += [...alphabet][int([...alphabet].length)];
    return s;
  };
  return { next, int, str };
}
