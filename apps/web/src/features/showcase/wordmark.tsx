/** The brand's name in two tones: the first word white, the rest lime (navy surfaces only). */
export function Wordmark({ name }: { name: string }) {
  const [first, ...rest] = name.split(" ");
  return (
    <>
      {first}
      {rest.length > 0 ? <span className="text-green-500"> {rest.join(" ")}</span> : null}
    </>
  );
}
