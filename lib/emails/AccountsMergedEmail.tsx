import { Heading, Text } from '@react-email/components'
import { EmailLayout } from './components/Layout'
import { EmailFooter } from './components/Footer'

export type AccountsMergedEmailProps = {
  name: string
  /** The address the one account now signs in with, partly hidden. */
  signInWith: string | null
  supportEmail: string
  appUrl: string
}

/** Tells someone an admin folded their two accounts into one, and how to sign in now. */
export function AccountsMergedEmail({
  name,
  signInWith,
  supportEmail,
  appUrl,
}: AccountsMergedEmailProps) {
  return (
    <EmailLayout>
      <Heading as="h2">Your two Action Hub accounts are now one</Heading>
      <Text>{`Hi ${name},`}</Text>
      <Text>
        It looked as though you had two accounts on Action Hub, so someone who helps run it has
        joined them into one. Your projects, tasks, teams and messages are all together now.
      </Text>
      <Text>
        {signInWith
          ? `Sign in from now on with ${signInWith}, and that account's password or Google.`
          : 'Sign in with Google from now on.'}
      </Text>
      <Text>
        If these weren&apos;t both yours, please write to{' '}
        <a href={`mailto:${supportEmail}`}>{supportEmail}</a> straight away.
      </Text>
      <EmailFooter appUrl={appUrl} />
    </EmailLayout>
  )
}
