import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';

export function useResource<T = any>(load: () => Promise<T>, deps: DependencyList = []) {
  const loader = useRef(load); loader.current = load;
  const sequence = useRef(0), alive = useRef(true);
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    const id = ++sequence.current; setLoading(true); setError(null);
    try { const result = await loader.current(); if (alive.current && id === sequence.current) setData(result); }
    catch (failure) { if (alive.current && id === sequence.current) { setData(null); setError(failure instanceof Error ? failure.message : '读取失败'); } }
    finally { if (alive.current && id === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  useEffect(() => { setData(null); void refresh(); return () => { sequence.current++; }; }, deps);
  return { data, error, loading, refresh };
}
