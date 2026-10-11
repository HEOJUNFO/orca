/**
 * An `ssh:<target>` host names an SSH target, never a route: this process serves no SSH provider,
 * so work routed to one fails with this error. A managed host is reached as `runtime:<env>`.
 */
export const SSH_HOST_NOT_SERVED_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

export class SshHostNotServedError extends Error {
  readonly code = 'ssh_host_not_served'

  constructor(readonly connectionId: string) {
    super(SSH_HOST_NOT_SERVED_MESSAGE)
    this.name = 'SshHostNotServedError'
  }
}
