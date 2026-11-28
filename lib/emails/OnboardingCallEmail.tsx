import { Heading, Section, Text } from '@react-email/components'
import { EmailLayout } from './components/Layout'
import { EmailButton } from './components/EmailButton'
import { EmailFooter, type FooterButton } from './components/Footer'

export type OnboardingCallEmailProps = {
  name: string
  heading: string
  paragraphs: string[]
  buttons: FooterButton[]
  appUrl: string
}

/** Everything the Global Onboarding team is sent about a call: reminders, cover, swaps. */
export function OnboardingCallEmail({
  name,
  heading,
  paragraphs,
  buttons,
  appUrl,
}: OnboardingCallEmailProps) {
  return (
    <EmailLayout>
      <Heading as="h2">{heading}</Heading>
      <Text>{`Hi ${name},`}</Text>
      {paragraphs.map((p) => (
        <Text key={p}>{p}</Text>
      ))}
      <Section style={{ textAlign: 'center', margin: '32px 0' }}>
        {buttons.map((b) => (
          <span key={b.url} style={{ display: 'inline-block', margin: '0 8px 8px' }}>
            <EmailButton href={b.url}>{b.label}</EmailButton>
          </span>
        ))}
      </Section>
      <EmailFooter appUrl={appUrl} buttons={buttons} />
    </EmailLayout>
  )
}
