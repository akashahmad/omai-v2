import { afterEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { visualScript } from "@opencode/core/preview/visual"

const PARENT = "http://localhost:4096"

const FIXTURE = `<main><h1 id="t">Hello <b>you</b></h1><p class="lead">One</p><p>Two</p><img src="/a.png" alt="A"><a href="/next" id="go">Next</a></main>`

const windows: Window[] = []

afterEach(() => {
  windows.splice(0).forEach((window) => window.close())
})

type Posted = { type: string; v?: number; [key: string]: unknown }

// A preview page in a frame of the app at PARENT, with the editor installed.
function page(html = FIXTURE) {
  const window = new Window({ url: "http://127.0.0.1:5000/" })
  windows.push(window)
  window.document.body.innerHTML = html
  const posted: Posted[] = []
  const parent = {
    postMessage: (message: Posted, origin: string) => {
      if (origin === PARENT) posted.push(message)
    },
  }
  Object.defineProperty(window, "parent", { value: parent })
  window.eval(visualScript(PARENT))
  const document = window.document
  const send = (command: Record<string, unknown>, origin = PARENT) =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        origin,
        source: parent as never,
        data: { type: "omai:visual:command", v: 1, command },
      }),
    )
  const click = (selector: string, type = "click") => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true })
    document.querySelector(selector)!.dispatchEvent(event)
    return event
  }
  const key = (target: Element, name: string, init: Record<string, unknown> = {}) =>
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }))
  const last = (type: string) => posted.findLast((message) => message.type === type)
  const settle = () => window.happyDOM.waitUntilComplete()
  return { window, document, posted, send, click, key, last, settle }
}

type Element = InstanceType<Window["Element"]>

describe("visual editor", () => {
  // The proxy serves the editor as its function's source text, so it must run with nothing from its module around it.
  test("runs in a fresh page without module scope", () => {
    expect(() => page()).not.toThrow()
  })

  test("announces itself once loaded, then does nothing while disabled", () => {
    const view = page()
    const event = view.click("p.lead")

    expect(event.defaultPrevented).toBe(false)
    expect(view.posted).toEqual([{ type: "omai:visual:loaded", v: 1 }])
  })

  test("enable then click selects and reports the element", () => {
    const view = page()
    view.send({ name: "enable" })
    const event = view.click("p.lead")
    const element = view.last("omai:visual:select")?.element as {
      tag: string
      path: string
      fingerprint: { classes: string[] }
      breadcrumb: { path: string }[]
    }

    expect(event.defaultPrevented).toBe(true)
    expect(view.last("omai:visual:ready")).toMatchObject({ v: 1 })
    expect(element.tag).toBe("p")
    expect(element.fingerprint.classes).toContain("lead")
    expect(view.document.querySelector(element.path)).toBe(view.document.querySelector("p.lead"))
    expect(element.breadcrumb.at(-1)?.path).toBe(element.path)
  })

  test("reports every font family the page uses, most used first", () => {
    const view = page(`<main style="font-family: Georgia, serif"><h1 style="font-family: Inter, sans-serif">A</h1><p>B</p><p>C</p></main>`)
    view.send({ name: "enable" })
    const fonts = view.last("omai:visual:ready")?.fonts as string[]

    expect(fonts).toContain("Inter, sans-serif")
    expect(fonts.indexOf("Georgia, serif")).toBeLessThan(fonts.indexOf("Inter, sans-serif"))
  })

  test("reports an image's full address, for showing it outside the page", () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("img")
    view.send({ name: "attribute", attr: "src", value: "/images/new.png" })
    const element = view.last("omai:visual:select")?.element as { src: string; srcUrl: string }

    expect(element.src).toBe("/images/new.png")
    expect(element.srcUrl).toBe("http://127.0.0.1:5000/images/new.png")
  })

  // Responsive images show their srcset pick, not src, so a new src alone would change nothing on screen.
  test("replacing a responsive image's src sets its srcset and sizes aside, and revert brings them back", () => {
    const view = page(`<main><img id="hero" src="/a.png" srcset="/a-1x.png 1x, /a-2x.png 2x" sizes="100vw" alt="A"></main>`)
    view.send({ name: "enable" })
    view.click("#hero")
    view.send({ name: "attribute", attr: "src", value: "/images/new.png" })
    const image = view.document.querySelector("#hero")!

    expect(image.getAttribute("src")).toBe("/images/new.png")
    expect(image.hasAttribute("srcset")).toBe(false)
    expect(image.hasAttribute("sizes")).toBe(false)
    view.send({ name: "revert", change: view.last("omai:visual:change")?.change })
    expect(image.getAttribute("src")).toBe("/a.png")
    expect(image.getAttribute("srcset")).toBe("/a-1x.png 1x, /a-2x.png 2x")
    expect(image.getAttribute("sizes")).toBe("100vw")
  })

  test("replacing an image inside <picture> sets its sources aside too", () => {
    const view = page(
      `<main><picture><source id="s" type="image/webp" srcset="/a.webp"><img id="pic" src="/a.png" alt="A"></picture></main>`,
    )
    view.send({ name: "enable" })
    view.click("#pic")
    view.send({ name: "attribute", attr: "src", value: "https://example.com/b.png" })
    const source = view.document.querySelector("#s")!

    expect(source.hasAttribute("srcset")).toBe(false)
    view.send({ name: "revert", change: view.last("omai:visual:change")?.change })
    expect(source.getAttribute("srcset")).toBe("/a.webp")
  })

  test("links don't navigate while editing", () => {
    const view = page()
    view.send({ name: "enable" })

    expect(view.click("#go").defaultPrevented).toBe(true)
  })

  test("style command applies live and reports before and after", () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("p.lead")
    view.send({ name: "style", property: "font-size", value: "24px" })
    const lead = view.document.querySelector("p.lead") as unknown as { style: { getPropertyValue(name: string): string } }

    expect(lead.style.getPropertyValue("font-size")).toBe("24px")
    expect(view.last("omai:visual:change")?.change).toMatchObject({ kind: "style", property: "font-size", after: "24px" })
  })

  test("inline text edit keeps child markup", () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("#t", "dblclick")
    const heading = view.document.querySelector("#t")!
    ;(heading.firstChild as unknown as { data: string }).data = "Hi "
    view.key(heading, "Enter")

    expect(heading.innerHTML).toBe("Hi <b>you</b>")
    expect(heading.getAttribute("contenteditable")).toBeNull()
    expect(view.last("omai:visual:change")?.change).toMatchObject({
      kind: "text",
      before: "Hello you",
      after: "Hi you",
      html: "Hi <b>you</b>",
    })
  })

  test("escape cancels an inline text edit", () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("#t", "dblclick")
    const heading = view.document.querySelector("#t")!
    ;(heading.firstChild as unknown as { data: string }).data = "Nope "
    view.key(heading, "Escape")

    expect(heading.innerHTML).toBe("Hello <b>you</b>")
    expect(view.last("omai:visual:change")).toBeUndefined()
  })

  test("move reorders among siblings", () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("p:not(.lead)")
    view.send({ name: "move", delta: -1 })
    const paragraphs = [...view.document.querySelectorAll("p")].map((element) => element.textContent)

    expect(paragraphs).toEqual(["Two", "One"])
    expect(view.last("omai:visual:change")?.change).toMatchObject({ kind: "move", before: "3", after: "2" })
  })

  test("selection survives a re-render", async () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("p.lead")
    const fresh = view.document.createElement("p")
    fresh.className = "lead"
    fresh.textContent = "One"
    view.document.querySelector("p.lead")!.replaceWith(fresh)
    await view.settle()
    const element = view.last("omai:visual:select")?.element as { path: string } | null

    expect(element && view.document.querySelector(element.path)).toBe(fresh)
  })

  test("a selection that disappears is cleared", async () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("img")
    view.document.querySelector("img")!.remove()
    await view.settle()

    expect(view.last("omai:visual:select")?.element).toBeNull()
  })

  test("apply re-creates pending changes after reload", () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("p.lead")
    view.send({ name: "style", property: "color", value: "red" })
    const change = view.last("omai:visual:change")?.change

    const reloaded = page()
    reloaded.send({ name: "enable" })
    reloaded.send({ name: "apply", changes: [change] })
    const lead = reloaded.document.querySelector("p.lead") as unknown as { style: { color: string } }

    expect(lead.style.color).toBe("red")
    expect(reloaded.last("omai:visual:change")).toBeUndefined()
  })

  test("revert undoes a change in the page", () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("p.lead")
    view.send({ name: "text", value: "Uno" })
    const change = view.last("omai:visual:change")?.change
    view.send({ name: "revert", change })

    expect(view.document.querySelector("p.lead")!.textContent).toBe("One")
  })

  test("disable removes every listener and the overlay", () => {
    const view = page()
    view.send({ name: "enable" })
    view.click("p.lead")
    view.send({ name: "disable" })

    expect(view.document.querySelectorAll("[data-omai-visual-ui]").length).toBe(0)
    expect(view.click("p.lead").defaultPrevented).toBe(false)
  })

  test("ignores commands from other origins and other versions", () => {
    const view = page()
    view.send({ name: "enable" }, "https://evil.example")
    view.window.dispatchEvent(
      new view.window.MessageEvent("message", {
        origin: PARENT,
        source: view.window.parent as never,
        data: { type: "omai:visual:command", v: 2, command: { name: "enable" } },
      }),
    )

    expect(view.click("p.lead").defaultPrevented).toBe(false)
    expect(view.posted).toEqual([{ type: "omai:visual:loaded", v: 1 }])
  })
})
