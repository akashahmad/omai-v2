import { Badge } from "@opencode/ui/badge"
import { Dialog, DialogBody } from "@opencode/ui/dialog"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { Keybind } from "@opencode/ui/keybind"
import { MenuScroll } from "@opencode/ui/menu-scroll"
import {
  displayName,
  getProjectAvatarGenerated,
  getProjectAvatarSource,
  getProjectAvatarVariant,
  ProjectAvatar,
} from "@opencode/ui/project-avatar"
import { TextInput } from "@opencode/ui/text-input"
import { createTypeahead } from "@opencode/ui/typeahead"
import { createEventListener } from "@solid-primitives/event-listener"
import { createEffect, createMemo, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptProject, PromptProjectController, PromptServer } from "@/new-session/project/selector"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import "@/shell/commands/dialog.css"
import "@/shell/palette-menu.css"
import "./dialog.css"

type LocationEntry =
  | { id: string; type: "project"; project: PromptProject }
  | { id: string; type: "add" }
  | { id: string; type: "other" }
  | { id: string; type: "server"; server: PromptServer }

/**
 * Opens the new-session location dialog: added projects across ready servers and a separate list of other server
 * projects. Adding a project picks the server when there are several.
 */
export function useNewSessionLocationDialog(input: { project: PromptProjectController; onDone: () => void }) {
  const dialog = useDialog()

  return () => {
    void dialog.show(() => <NewSessionLocationDialog project={input.project} />, input.onDone)
  }
}

function NewSessionLocationDialog(props: { project: PromptProjectController }) {
  const dialog = useDialog()
  const language = useLanguage()
  const command = useCommand()

  const [store, setStore] = createStore<{
    /** Picking the server to add a project to. */
    picking?: boolean
    /** Browsing server projects this client has not added. */
    others: boolean
    query: string
    /** The projects view to restore when stepping back out of the server step. */
    back?: { query: string; active: string; others: boolean }
  }>({
    query: "",
    others: false,
  })

  const matches = (...values: (string | undefined)[]) => {
    const query = store.query.trim().toLowerCase()

    return !query || values.some((value) => value?.toLowerCase().includes(query))
  }

  const otherCount = createMemo(() => props.project.projects().filter((project) => !project.used).length)

  const projectEntries = createMemo<LocationEntry[]>(() => {
    return [
      ...props.project
        .projects()
        .filter((project) => (store.others ? !project.used : project.used || !!store.query.trim()))
        // Remote projects also match their server's name, which their tag shows.
        .filter((project) => matches(displayName(project), project.worktree, tagged(project.server)?.name))
        .map((project) => ({ id: projectEntryID(project), type: "project" as const, project })),
      ...(!store.others
        ? [
            ...(!store.query.trim() && otherCount() ? [{ id: "other", type: "other" as const }] : []),
            { id: "add", type: "add" as const },
          ]
        : []),
    ]
  })

  const firstOther = createMemo(
    () => projectEntries().find((entry) => entry.type === "project" && !entry.project.used)?.id,
  )

  const serverEntries = createMemo<LocationEntry[]>(() =>
    props.project
      .servers()
      .filter((server) => matches(server.name))
      .map((server) => ({ id: `server:${server.key}`, type: "server" as const, server })),
  )

  const entries = () => {
    if (store.picking) return serverEntries()

    return projectEntries()
  }

  const title = () => {
    if (store.picking) return language.t("session.new.location.servers")

    if (store.others) return language.t("session.new.location.otherProjects")

    return undefined
  }

  const placeholder = () => {
    if (store.picking) return language.t("session.new.location.servers.search")

    return language.t("session.new.project.search")
  }

  const choosesServer = () => props.project.servers().length > 1
  command.register("new-session-location", () => [
    {
      id: "project.open",
      title: language.t("command.project.open"),
      category: language.t("command.category.project"),
      keybind: "mod+o",
      onSelect: () => choose({ id: "add", type: "add" }),
    },
  ])
  createEventListener(document, "keydown", (event) => {
    if (event.isComposing || !command.matches("project.open", event)) return
    event.preventDefault()
    event.stopPropagation()
    command.trigger("project.open", "keybind")
  })

  // Every step opens on its first row; the user's choice holds while it stays in the results.
  const typeahead = createTypeahead<LocationEntry>({
    items: entries,
    key: (entry) => entry.id,
    onSelect: choose,
  })

  const activeEntry = typeahead.activeItem

  let resultsRef: HTMLDivElement | undefined
  let inputRef: HTMLInputElement | undefined

  createEffect(() => {
    if (!activeEntry()) return

    const frame = requestAnimationFrame(() =>
      resultsRef?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" }),
    )

    onCleanup(() => cancelAnimationFrame(frame))
  })

  function pick() {
    setStore({
      picking: true,
      query: "",
      back: { query: store.query, active: "add", others: store.others },
    })
    inputRef?.focus()
  }

  function back() {
    const active = store.picking ? store.back?.active : "other"
    setStore({
      picking: undefined,
      others: store.picking ? (store.back?.others ?? false) : false,
      query: store.picking ? (store.back?.query ?? "") : "",
      back: undefined,
    })
    typeahead.setActive(active)
    inputRef?.focus()
  }

  function choose(entry: LocationEntry | undefined) {
    if (!entry) return

    if (entry.type === "other") {
      setStore({ others: true, query: "" })
      inputRef?.focus()

      return
    }

    if (entry.type === "add" && choosesServer()) {
      pick()

      return
    }

    if (entry.type === "add") {
      dialog.close()
      props.project.add()

      return
    }

    if (entry.type === "server") {
      dialog.close()
      props.project.add(entry.server.key)

      return
    }

    props.project.select(entry.project)
    dialog.close()
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    // SAFETY: this handler is only attached to the search TextInput's <input>, so currentTarget is that element.
    const target = event.currentTarget as HTMLInputElement
    const atEnd = target.selectionStart === target.value.length && target.selectionEnd === target.value.length
    const atStart = target.selectionStart === 0 && target.selectionEnd === 0
    const active = activeEntry()
    const forward = language.direction() === "rtl" ? "ArrowLeft" : "ArrowRight"
    const backward = language.direction() === "rtl" ? "ArrowRight" : "ArrowLeft"

    if (event.key === forward && atEnd && active?.type === "add" && choosesServer()) {
      event.preventDefault()
      pick()

      return
    }

    if (active?.type === "other" && atEnd && event.key === forward) {
      event.preventDefault()
      choose(active)

      return
    }

    if (
      (store.picking || store.others) &&
      ((event.key === backward && atStart) || (event.key === "Backspace" && !target.value) || event.key === "Escape")
    ) {
      event.preventDefault()
      event.stopPropagation()
      back()

      return
    }

    typeahead.onKeyDown(event)
  }

  return (
    <Dialog class="command-palette new-session-location" size="large">
      <DialogBody class="command-palette-body">
        <div class="palette-menu-search">
          <TextInput
            ref={inputRef}
            value={store.query}
            autofocus
            autocomplete="off"
            spellcheck={false}
            appearance="large"
            aria-label={placeholder()}
            placeholder={placeholder()}
            leadingIcon={<Icon name="magnifying-glass" />}
            role="combobox"
            aria-expanded="true"
            data-owns-escape={store.picking || store.others ? "" : undefined}
            aria-controls={typeahead.listID}
            aria-activedescendant={typeahead.activeID()}
            onInput={(event) => setStore("query", event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div class="new-session-location-divider" aria-hidden="true" />
        <MenuScroll
          class="min-h-0 flex-1"
          viewportClass="command-palette-scroll"
          viewportRef={(el) => (resultsRef = el)}
        >
          <div id={typeahead.listID} class="command-palette-results" role="listbox">
            <div class="command-palette-group">
              <Show when={title()}>
                {(value) => (
                  <button
                    type="button"
                    class="command-palette-group-title new-session-location-back"
                    aria-label={language.t("session.new.location.back")}
                    onClick={back}
                  >
                    {value()}
                  </button>
                )}
              </Show>
              <Show
                when={entries().length > 0}
                fallback={<div class="command-palette-state">{language.t("palette.empty")}</div>}
              >
                <For each={entries()}>
                  {(entry, index) => (
                    <>
                      <Show when={store.query.trim() && !store.picking && !store.others && entry.id === firstOther()}>
                        <div class="command-palette-group-title">
                          {language.t("session.new.location.otherProjects")}
                        </div>
                      </Show>
                      <Show when={index() > 0 && entry.type === "add"}>
                        <div class="new-session-location-action-divider" role="separator" />
                      </Show>
                      <button
                        type="button"
                        id={typeahead.optionID(entry)}
                        class="command-palette-row palette-menu-row"
                        data-size="compact"
                        classList={{ "new-session-location-option": entry.type === "other" || entry.type === "add" }}
                        role="option"
                        aria-selected={activeEntry()?.id === entry.id}
                        data-active={activeEntry()?.id === entry.id ? "" : undefined}
                        onMouseMove={(event) => {
                          // Ignore hover from a static cursor when keyboard scrolling moves rows underneath it.
                          if (event.movementX === 0 && event.movementY === 0) return
                          typeahead.setActive(entry.id)
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onFocus={() => typeahead.setActive(entry.id)}
                        onClick={() => choose(entry)}
                      >
                        <Switch>
                          <Match when={entry.type === "project" && entry}>
                            {(item) => <ProjectRow project={item().project} path={item().project.worktree} />}
                          </Match>
                          <Match when={entry.type === "other"}>
                            <div class="command-palette-row-main new-session-location-other">
                              <Icon name="menu" class="command-palette-row-icon" />
                              <span class="command-palette-title palette-menu-title">
                                {language.t("session.new.location.otherProjects")}
                              </span>
                              <span class="new-session-location-count">{otherCount()}</span>
                            </div>
                            <DrillButton
                              label={language.t("session.new.location.otherProjects")}
                              onDrill={() => choose(entry)}
                            />
                          </Match>
                          <Match when={entry.type === "add"}>
                            <div class="command-palette-row-main">
                              <Icon name="plus" class="command-palette-row-icon" />
                              <div class="command-palette-row-text">
                                <span class="command-palette-title palette-menu-title">
                                  {language.t("session.new.project.add")}
                                </span>
                              </div>
                            </div>
                            <Show when={command.keybindParts("project.open").length}>
                              <Keybind keys={command.keybindParts("project.open")} variant="neutral" class="shrink-0" />
                            </Show>
                            <Show when={choosesServer()}>
                              <DrillButton label={language.t("session.new.location.servers")} onDrill={pick} />
                            </Show>
                          </Match>
                          <Match when={entry.type === "server" && entry}>
                            {(item) => (
                              <div class="command-palette-row-main">
                                <Icon name={serverIcon(item().server)} class="command-palette-row-icon" />
                                <div class="command-palette-row-text">
                                  <span class="command-palette-title palette-menu-title">{item().server.name}</span>
                                  <Show when={item().server.hint}>
                                    {(hint) => <span class="command-palette-description">{hint()}</span>}
                                  </Show>
                                </div>
                              </div>
                            )}
                          </Match>
                        </Switch>
                      </button>
                    </>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </MenuScroll>
      </DialogBody>
    </Dialog>
  )
}

function ProjectRow(props: { project: PromptProject; path: string }) {
  return (
    <div class="command-palette-row-main">
      <ProjectAvatar
        class="shrink-0"
        fallback={displayName(props.project)}
        src={getProjectAvatarSource(props.project.id, props.project.icon)}
        variant={getProjectAvatarVariant(props.project.icon?.color)}
        generated={getProjectAvatarGenerated(props.project)}
      />
      <div class="command-palette-row-text">
        <span class="new-session-location-name">
          <span class="command-palette-title palette-menu-title">{displayName(props.project)}</span>
          <ServerTag server={props.project.server} />
        </span>
        <span class="command-palette-description" dir="ltr">
          {props.path}
        </span>
      </div>
    </div>
  )
}

function DrillButton(props: { label: string; onDrill: () => void }) {
  return (
    <span
      role="button"
      aria-label={props.label}
      class="new-session-location-drill"
      onClick={(event) => {
        event.stopPropagation()
        props.onDrill()
      }}
    >
      <Icon name="chevron-right" />
    </span>
  )
}

/** The server a project lives on; projects on the current server have none. */
function ServerTag(props: { server?: PromptServer }) {
  return (
    <Show when={tagged(props.server)}>
      {(server) => (
        <Badge class="new-session-location-tag" variant="subtle" title={server().label}>
          <Icon name={serverIcon(server())} size="small" />
          <span>{server().name}</span>
        </Badge>
      )}
    </Show>
  )
}

function projectEntryID(project: PromptProject) {
  return `project:${project.server?.key ?? ""}:${project.worktree}`
}

function tagged(server?: PromptServer) {
  return server?.kind === "current" ? undefined : server
}

function serverIcon(server: PromptServer) {
  if (server.kind === "current") return "monitor"

  return server.kind === "plugin" ? "terminal" : "globe"
}
