import { createContext, useContext } from 'react'

export const ModalDismissContext = createContext<() => void>(() => {})

/** Call from event handlers inside ModalDialog to close. */
export function useModalDismiss(): () => void {
  return useContext(ModalDismissContext)
}
