import { Heading, Section, Text } from '@react-email/components'
import { EmailLayout } from './components/Layout'
import { EmailButton } from './components/EmailButton'
import { EmailFooter } from './components/Footer'

export type StaffMergeConfirmEmailProps = {
  confirmUrl: string
  name: string
  appUrl: string
}

/**
 * Sent to each of two accounts' addresses when an admin thinks one person holds both; the merge
 * runs only once the links sent to both are followed.
 */
export function StaffMergeConfirmEmail({ confirmUrl, name, appUrl }: StaffMergeConfirmEmailProps) {
  return (
    <EmailLayout>
      <Heading as="h2">Are these both your Action Hub accounts?</Heading>
      <Text>{`Hi ${name},`}</Text>
      <Text>
        Someone who helps run Action Hub thinks this account and another one belong to the same
        person, and would like to join them into one. We have sent a link like this to the other
        account&apos;s address too.
      </Text>
      <Text>
        If both are yours, follow the link here and the one sent to the other address. Your
        projects, tasks, teams and messages will then all be in one account.
      </Text>
      <Section style={{ textAlign: 'center', margin: '32px 0' }}>
        <EmailButton href={confirmUrl}>Yes, they are both mine</EmailButton>
      </Section>
      <Text>
        This link expires in <strong>7 days</strong>. If they aren&apos;t both yours, ignore this
        email and nothing will change.
      </Text>
      <EmailFooter
        appUrl={appUrl}
        buttons={[{ label: 'Yes, they are both mine', url: confirmUrl }]}
      />
    </EmailLayout>
  )
}
