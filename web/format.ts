import { Code, ConnectError } from '@connectrpc/connect'
import { timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt'
import { Status } from '../gen/ops/v1/incidents_pb.ts'

export const STATUS_LABEL: Record<number, string> = {
  [Status.TRIGGERED]: 'Triggered',
  [Status.ACKNOWLEDGED]: 'Acknowledged',
  [Status.MITIGATED]: 'Mitigated',
  [Status.RESOLVED]: 'Resolved',
}

export const sevLabel = (sev: number): string => `SEV${sev}`

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function ago(ts: Timestamp | undefined, now = Date.now()): string {
  if (!ts) return ''
  const s = Math.round((timestampMs(ts) - now) / 1000)
  if (Math.abs(s) < 60) return rtf.format(s, 'second')
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86400), 'day')
}

export function clock(ts: Timestamp | undefined): string {
  return ts ? new Date(timestampMs(ts)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''
}

// What to tell a person, by Connect error code.
export function explain(err: unknown): string {
  const e = ConnectError.from(err)
  switch (e.code) {
    case Code.Aborted:
      return 'Someone else changed this incident while you had it open. You now see the latest version: check it, then try again.'
    case Code.FailedPrecondition:
      return `Not possible any more: ${e.rawMessage}.`
    case Code.PermissionDenied:
      return 'Your role can view incidents but not change them.'
    case Code.Unauthenticated:
      return 'Your session ended. Sign in again.'
    case Code.InvalidArgument:
      return e.rawMessage.charAt(0).toUpperCase() + e.rawMessage.slice(1) + '.'
    default:
      return `Something went wrong (${Code[e.code]}): ${e.rawMessage}`
  }
}
