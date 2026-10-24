import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

export function useUrlState<T extends string>(key: string, defaultValue: T, allowedValues: readonly T[]): [T, Dispatch<SetStateAction<T>>];
export function useUrlState(key: string, defaultValue?: string): [string, Dispatch<SetStateAction<string>>];
export function useUrlState(key: string, defaultValue = "", allowedValues?: readonly string[]): [string, Dispatch<SetStateAction<string>>] {
  const [value, setValue] = useState(() => readParam(key, defaultValue, allowedValues));
  // Inline option lists must not reinstall a listener during navigation updates.
  const allowedValuesJson = JSON.stringify(allowedValues);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (value === defaultValue || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [key, value, defaultValue]);

  useEffect(() => {
    const validValues: string[] | undefined = allowedValuesJson === undefined ? undefined : JSON.parse(allowedValuesJson);
    const restore = () => setValue(readParam(key, defaultValue, validValues));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [key, defaultValue, allowedValuesJson]);

  return [value, setValue];
}

function readParam(key: string, defaultValue: string, allowedValues?: readonly string[]) {
  if (typeof window === "undefined") return defaultValue;
  const value = new URLSearchParams(window.location.search).get(key);
  return value !== null && (!allowedValues || allowedValues.includes(value)) ? value : defaultValue;
}
