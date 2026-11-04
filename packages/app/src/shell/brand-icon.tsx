/** The app icon: the brand mark on its blue tile. Size and corner radius come from the caller. */
export function BrandIcon(props: { class?: string; label?: string }) {
  return (
    <img
      src="/web-app-manifest-192x192.png"
      alt={props.label ?? ""}
      draggable={false}
      classList={{ "select-none": true, [props.class ?? ""]: !!props.class }}
    />
  )
}
