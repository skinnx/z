/** Controlled-or-uncontrolled state, standing in for @radix-ui/react-use-controllable-state. */
import { useCallback, useRef, useState } from "react";

export function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop?: T;
  defaultProp: T;
  onChange?: (value: T) => void;
}): [T, (value: T) => void] {
  const [inner, setInner] = useState(defaultProp);
  const controlled = prop !== undefined;
  const value = controlled ? prop : inner;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  const set = useCallback(
    (next: T) => {
      if (Object.is(next, valueRef.current)) return;
      if (!controlled) setInner(next);
      onChangeRef.current?.(next);
    },
    [controlled],
  );
  return [value, set];
}
