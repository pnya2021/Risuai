import { securityConfirmationQueue } from './securityConfirmationQueue'

export const approveSecurityConfirmation = (digest: string, presentationId: string) =>
    securityConfirmationQueue.decide(digest, presentationId, true)

export const denySecurityConfirmation = (digest: string, presentationId: string) =>
    securityConfirmationQueue.decide(digest, presentationId, false)
