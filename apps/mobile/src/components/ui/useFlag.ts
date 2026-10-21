import { useCallback, useState } from "react";

/** A boolean with stable on/off setters, for press and focus feedback: `[value, setOn, setOff]`. */
export function useFlag(): [boolean, () => void, () => void] {
  const [value, setValue] = useState(false);
  const setOn = useCallback(() => setValue(true), []);
  const setOff = useCallback(() => setValue(false), []);
  return [value, setOn, setOff];
}
