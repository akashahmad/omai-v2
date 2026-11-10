import { createContext, useContext, type ParentProps } from "solid-js"

/** Where an image edited in the image preview goes: the chat's composer, as a new attachment. */
export type ImageEdit = {
  /** Whether an edited image can be attached right now; editing is offered only then. */
  available: () => boolean
  attach: (file: File) => void
}

const ImageEditContext = createContext<ImageEdit>()

export function ImageEditProvider(props: ParentProps<{ value: ImageEdit }>) {
  return <ImageEditContext.Provider value={props.value}>{props.children}</ImageEditContext.Provider>
}

/** The edit target, when the preview opens where an edited image can be attached; otherwise editing is not offered. */
export function useImageEdit() {
  return useContext(ImageEditContext)
}
