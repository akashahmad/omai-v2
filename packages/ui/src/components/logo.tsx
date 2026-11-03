// One aperture blade, centred on the origin; the mark is eight of them, each turned 45° from the last.
const blade = "M-26 -631L364 -566L-206 -316Z"
const turns = [0, 45, 90, 135, 180, 225, 270, 315]

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="-700 -700 1400 1400"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="currentColor" stroke="currentColor" stroke-width="28" stroke-linejoin="round">
        {turns.map((turn) => (
          <path d={blade} transform={`rotate(${turn})`} />
        ))}
      </g>
    </svg>
  )
}

/** The brand's plus: a four-point sparkle, `r` from its centre to each point. */
export function sparkle(x: number, y: number, r: number) {
  return `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-wordmark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="currentColor"
      role="img"
      aria-label="O M A I +"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text x="0" y="34" font-size="36" font-weight="300" textLength="190" lengthAdjust="spacing">
        O M A I
      </text>
      <path d={sparkle(218, 21, 14)} />
    </svg>
  )
}
