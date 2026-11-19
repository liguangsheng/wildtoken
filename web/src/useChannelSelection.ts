import { useCallback, useEffect, useMemo, useState } from "react";

import { listUpstreams } from "./api";
import { candidateModels } from "./debugRequest";
import { useRemoteResource } from "./useRemoteResource";

/** 切回常驻页时重取渠道，不改请求草稿和正在接收的结果。 */
export function useChannelSelection(active: boolean, onUnauthorized: (message: string) => void) {
  const resource = useRemoteResource(listUpstreams, onUnauthorized, active);
  const [chosen, setChosen] = useState<number[]>([]);
  const upstreams = useMemo(() => (resource.data ?? []).filter((item) => !item.archived), [resource.data]);
  const liveIds = useMemo(() => new Set(upstreams.map((item) => item.id)), [upstreams]);
  const selected = useMemo(() => chosen.filter((id) => liveIds.has(id)), [chosen, liveIds]);

  useEffect(() => {
    if (!resource.data) return;
    setChosen((current) => {
      const next = current.filter((id) => liveIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [resource.data, liveIds]);

  const toggleChannel = useCallback((id: number) => {
    setChosen((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }, []);
  const selectChannels = useCallback((ids: number[]) => {
    setChosen([...new Set(ids)].filter((id) => liveIds.has(id)));
  }, [liveIds]);
  const modelOptions = useMemo(() => candidateModels(upstreams, selected), [upstreams, selected]);

  return { upstreams, selected, toggleChannel, selectChannels, modelOptions, error: resource.error, loading: resource.loading, reload: resource.reload };
}
