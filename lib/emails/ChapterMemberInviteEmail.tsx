import { Heading, Section, Text } from '@react-email/components'
import { EmailLayout } from './components/Layout'
import { EmailButton } from './components/EmailButton'
import { EmailFooter } from './components/Footer'

export type ChapterMemberInviteEmailProps = {
  signupUrl: string
  invitedBy: string
  chapterName: string
  appUrl: string
}

/** A chapter's lead or deputy invites someone with no account to sign up and join it. */
export function ChapterMemberInviteEmail({
  signupUrl,
  invitedBy,
  chapterName,
  appUrl,
}: ChapterMemberInviteEmailProps) {
  return (
    <EmailLayout>
      <Heading as="h2">Join the PauseAI {chapterName} chapter</Heading>
      <Text>Hi there,</Text>
      <Text>
        <strong>{invitedBy}</strong> helps run the {chapterName} chapter of PauseAI and has invited
        you to join it on Action Hub, where volunteers find projects and tasks that need their
        skills.
      </Text>
      <Section style={{ textAlign: 'center', margin: '32px 0' }}>
        <EmailButton href={signupUrl}>Sign up</EmailButton>
      </Section>
      <Text>
        The form starts with this address and your chapter&apos;s country filled in. Your
        chapter&apos;s organisers look at new sign-ups before welcoming them in.
      </Text>
      <EmailFooter appUrl={appUrl} buttons={[{ label: 'Sign up', url: signupUrl }]} />
    </EmailLayout>
  )
}
