import { useQuery } from "@tanstack/react-query";
import { orpc } from "./orpc";
import { safeTimeZone } from "./time";

/** The signed-in user + their settings. Cached for the whole session. */
export function useMe() {
  return useQuery({ ...orpc.me.get.queryOptions(), staleTime: 60_000 });
}

/** The user's IANA time zone (validated), or undefined while `me.get` loads. */
export function useTimeZone(): string | undefined {
  const me = useMe();
  return me.data ? safeTimeZone(me.data.settings.timezone) : undefined;
}
