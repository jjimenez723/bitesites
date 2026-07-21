import React from 'react';
import { Link } from 'react-router-dom';
import { LegalLayout, Section } from './LegalLayout';
import { LEGAL } from './legal-details';

const SECTIONS = [
  ['scope', 'Scope of this policy'],
  ['collect', 'Information we collect'],
  ['voice', 'Microphone access and the Voice AI demo'],
  ['cookies', 'Cookies and local storage'],
  ['use', 'How we use information'],
  ['bases', 'Legal bases for processing'],
  ['sharing', 'When we share information'],
  ['selling', 'We do not sell your information'],
  ['retention', 'How long we keep information'],
  ['security', 'How we protect information'],
  ['rights', 'Your privacy rights'],
  ['appeals', 'Appealing a decision'],
  ['gpc', 'Do Not Track and Global Privacy Control'],
  ['children', "Children's privacy"],
  ['international', 'International visitors'],
  ['changes', 'Changes to this policy'],
  ['contact', 'How to reach us']
];

export default function Privacy() {
  return (
    <LegalLayout
      title="Privacy Policy"
      intro={`This policy explains what ${LEGAL.brand} collects when you use ${LEGAL.site}, why we collect it, who we share it with, and the choices you have. We have written it to describe what the site actually does — not to describe every practice we might one day adopt.`}
      sections={SECTIONS}
    >
      <Section id="scope" heading="1. Scope of this policy">
        <p>
          This Privacy Policy applies to {LEGAL.siteUrl} and the services offered through it,
          operated by {LEGAL.entity} (&ldquo;{LEGAL.brand},&rdquo; &ldquo;we,&rdquo;
          &ldquo;us,&rdquo; or &ldquo;our&rdquo;). It is part of, and should be read alongside, our{' '}
          <Link to="/terms">Terms of Service</Link>.
        </p>
        <p>
          It does not cover the websites, applications, or AI agents we build and operate on behalf of
          our clients. Those are governed by the privacy policies of the client who owns them. Where
          we handle personal information on a client&rsquo;s behalf under an engagement, we act as
          that client&rsquo;s processor or service provider, and our contract with them governs.
        </p>
      </Section>

      <Section id="collect" heading="2. Information we collect">
        <h3>Information you give us</h3>
        <p>
          When you submit our project intake form or complete the guided chat with our assistant, we
          collect the details you enter:
        </p>
        <ul>
          <li>your name and email address (required);</li>
          <li>your phone number, if you provide one or ask to be contacted by phone;</li>
          <li>your business or company name and your role there, if provided;</li>
          <li>
            your business size, project timeline, the services you are interested in, and your
            preferred contact method;
          </li>
          <li>any project details or free-text notes you choose to write.</li>
        </ul>
        <p>If you create an account, we also collect:</p>
        <ul>
          <li>your email address and a password;</li>
          <li>your display name, company, and phone number, if provided;</li>
          <li>
            authentication records — sign-in timestamps and account status — managed by Firebase
            Authentication. Your password is stored only as a salted hash by Google; we never see or
            store it in plain text.
          </li>
        </ul>

        <h3>Information from the Voice AI demo</h3>
        <p>
          If you start a call with our Voice AI receptionist demo, we and our voice platform provider
          process your microphone audio, and may retain a recording, a transcript, and call metadata,
          along with any details you give the agent. Section 3 explains this in full.
        </p>

        <h3>Information collected automatically</h3>
        <p>
          When you submit a form, we record limited technical context alongside your submission to
          help us understand where enquiries come from and to investigate abuse:
        </p>
        <ul>
          <li>the page path on our site you submitted from;</li>
          <li>the referring URL, if your browser sent one;</li>
          <li>your browser&rsquo;s user-agent string;</li>
          <li>a server-generated timestamp.</li>
        </ul>
        <p>
          Our hosting and infrastructure providers also process your IP address and standard server
          log data as part of delivering the site and protecting it from abuse.
        </p>

        <h3>What we do not collect</h3>
        <p>
          We do not ask for and do not want sensitive personal information — such as government
          identifiers, financial account numbers, health information, precise geolocation, or
          information revealing race, religion, or sexual orientation. Please do not include such
          details in free-text fields. We do not run advertising or cross-site tracking on this site.
        </p>
      </Section>

      <Section id="voice" heading="3. Microphone access and the Voice AI demo">
        <p>
          Our interactive Voice AI receptionist demo places a <strong>real voice call</strong> with an
          AI agent, and asks for permission to use your microphone in order to do so. Please treat it
          like a phone call rather than an on-page animation:
        </p>
        <ul>
          <li>
            <strong>Your speech leaves your device.</strong> Audio is streamed to our voice platform
            provider, GoHighLevel (LeadConnector), and the speech and conversational AI services it
            uses on our behalf, so the agent can hear you and respond in real time.
          </li>
          <li>
            <strong>Calls may be recorded and transcribed.</strong> The platform may retain call
            audio, transcripts, and metadata such as call duration and outcome, so that we can review
            conversations, improve the agent, and follow up on enquiries.
          </li>
          <li>
            <strong>A contact record may be created.</strong> If you share details during the call —
            your name, email, phone number, or what you are looking for — they may be stored in our
            customer relationship management system alongside the conversation.
          </li>
          <li>
            <strong>The demo is optional.</strong> You can decline the microphone permission, end the
            call at any time, or simply not start one. Declining does not affect your use of the rest
            of the site or your ability to contact us by form or email.
          </li>
        </ul>
        <p>
          Please do not share sensitive personal information during the demo. If you would like a
          call recording or transcript deleted, email{' '}
          <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a> and tell us roughly when
          the call took place so we can locate it.
        </p>
      </Section>

      <Section id="cookies" heading="4. Cookies and local storage">
        <p>
          We do not use advertising, analytics-profiling, or cross-site tracking cookies on this site.
        </p>
        <ul>
          <li>
            <strong>Authentication.</strong> If you sign in, Firebase Authentication stores a session
            token in your browser&rsquo;s local storage so you stay signed in. Clearing your browser
            storage signs you out.
          </li>
          <li>
            <strong>Abuse prevention.</strong> Where enabled, Google reCAPTCHA (via Firebase App
            Check) may set a cookie and collect device and interaction signals to distinguish real
            visitors from automated scripts. This is used only for security, not advertising.
          </li>
          <li>
            <strong>Fonts.</strong> Our typography is served by Google Fonts. Requesting a font
            reveals your IP address and user-agent to Google. Google states it does not use Google
            Fonts requests to profile users or serve ads.
          </li>
          <li>
            <strong>Voice AI demo.</strong> The demo loads a widget from GoHighLevel
            (LeadConnector), which may set its own cookies or local storage and apply its own bot
            protection in order to run and rate-limit calls.
          </li>
        </ul>
      </Section>

      <Section id="use" heading="5. How we use information">
        <p>We use the information described above to:</p>
        <ul>
          <li>respond to your enquiry and follow up about the services you asked about;</li>
          <li>prepare proposals, quotes and statements of work;</li>
          <li>create and administer accounts, and verify who is authorised to access what;</li>
          <li>provide, maintain, secure and improve the site and our services;</li>
          <li>
            detect, investigate and prevent fraud, spam, abuse and security incidents, and enforce our{' '}
            <Link to="/terms">Terms</Link>;
          </li>
          <li>keep business records and comply with legal obligations.</li>
        </ul>
        <p>
          We do not use your information to make automated decisions that produce legal or similarly
          significant effects about you, and we do not use it to train third-party AI models.
        </p>
      </Section>

      <Section id="bases" heading="6. Legal bases for processing">
        <p>
          If you are in the European Economic Area or the United Kingdom, our legal bases are: your{' '}
          <strong>consent</strong> (for example, when you grant microphone permission); the{' '}
          <strong>performance of a contract</strong> or steps taken at your request before entering
          one (responding to your enquiry, administering your account); our{' '}
          <strong>legitimate interests</strong> in securing the site, preventing abuse, and running
          and improving our business; and <strong>compliance with legal obligations</strong>. Where we
          rely on consent, you may withdraw it at any time.
        </p>
      </Section>

      <Section id="sharing" heading="7. When we share information">
        <p>We share personal information only in these circumstances:</p>
        <ul>
          <li>
            <strong>Service providers.</strong> Google (Firebase and Google Cloud) hosts our database
            and authentication and stores form submissions in United States data centres. GoHighLevel
            (LeadConnector), together with the speech and conversational AI services it uses, powers
            the Voice AI demo and our customer relationship management. Other providers may handle
            email delivery and business operations. Each is bound to process the information only on
            our instructions.
          </li>
          <li>
            <strong>Professional advisers.</strong> Lawyers, accountants and insurers where reasonably
            necessary.
          </li>
          <li>
            <strong>Legal requirements.</strong> Where required by law, subpoena, or other legal
            process, or where we reasonably believe disclosure is necessary to protect the rights,
            property or safety of {LEGAL.brand}, our clients, or the public.
          </li>
          <li>
            <strong>Business transfers.</strong> In connection with a merger, acquisition, financing,
            or sale of assets, in which case we will require the recipient to honour this policy or
            notify you of any material change.
          </li>
          <li>
            <strong>With your direction.</strong> Any other sharing you ask us or authorise us to do.
          </li>
        </ul>
      </Section>

      <Section id="selling" heading="8. We do not sell your information">
        <p>
          We do not sell personal information, and we do not share it for cross-context behavioural
          advertising or targeted advertising, as those terms are defined under the New Jersey Data
          Privacy Act, the California Consumer Privacy Act, and similar state laws. We have not done
          so in the preceding twelve months. We also do not use personal information for profiling in
          furtherance of decisions that produce legal or similarly significant effects.
        </p>
      </Section>

      <Section id="retention" heading="9. How long we keep information">
        <p>
          We keep form submissions for as long as needed to respond to your enquiry and for a
          reasonable period afterwards for business records — ordinarily up to{' '}
          <strong>24 months</strong> from your last contact with us, unless a longer period is
          required by law or the information relates to an active or prospective engagement.
        </p>
        <p>
          Account records are kept for as long as the account is active, and for a reasonable period
          after closure to resolve disputes and meet legal obligations. You can ask us to delete your
          information sooner — see below.
        </p>
      </Section>

      <Section id="security" heading="10. How we protect information">
        <p>
          Form submissions are transmitted over TLS and stored in Google Cloud Firestore. Access is
          restricted by server-enforced security rules: submissions can be created by the public form
          but cannot be read, edited, or deleted by anyone except an authenticated administrator.
          Roles and permissions are stored separately from user profiles, so an account cannot grant
          itself access. Passwords are hashed by Firebase Authentication and are never visible to us.
        </p>
        <p>
          No method of transmission or storage is completely secure, and we cannot guarantee absolute
          security. If we become aware of a breach affecting your personal information, we will notify
          you and the relevant authorities as required by law.
        </p>
      </Section>

      <Section id="rights" heading="11. Your privacy rights">
        <p>
          Depending on where you live, you may have some or all of the following rights. Residents of{' '}
          {LEGAL.governingState} have these rights under the New Jersey Data Privacy Act; residents of
          California, Colorado, Connecticut, Virginia, and other states with comprehensive privacy
          laws have comparable rights, as do individuals in the EEA and UK.
        </p>
        <ul>
          <li>
            <strong>Access.</strong> Confirm whether we process your personal information and obtain a
            copy of it.
          </li>
          <li>
            <strong>Correction.</strong> Correct inaccuracies, taking into account the nature and
            purpose of the processing.
          </li>
          <li>
            <strong>Deletion.</strong> Request that we delete personal information we hold about you.
          </li>
          <li>
            <strong>Portability.</strong> Obtain your information in a portable, readily usable format
            where processing is carried out by automated means.
          </li>
          <li>
            <strong>Opt out.</strong> Opt out of targeted advertising, the sale of personal
            information, or profiling with legal or similarly significant effects. As described above,
            we do not engage in any of these.
          </li>
          <li>
            <strong>Non-discrimination.</strong> We will not deny you services, charge you a different
            price, or provide a lesser quality of service for exercising these rights.
          </li>
        </ul>
        <p>
          To exercise a right, email{' '}
          <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a> with enough detail for us
          to locate your records. We will respond within 45 days, and may extend once by a further 45
          days where reasonably necessary, telling you why. We may need to verify your identity before
          acting — usually by confirming control of the email address in our records. An authorised
          agent may submit a request on your behalf with proof of authorisation.
        </p>
      </Section>

      <Section id="appeals" heading="12. Appealing a decision">
        <p>
          If we decline your request, we will tell you why. You may appeal that decision within a
          reasonable period by replying to our response or emailing{' '}
          <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a> with the subject line
          &ldquo;Privacy Appeal.&rdquo; We will respond in writing within 45 days with our decision
          and the reasons for it.
        </p>
        <p>
          If your appeal is denied, {LEGAL.governingState} residents may submit a complaint to the New
          Jersey Division of Consumer Affairs. Residents of other states may contact their state
          Attorney General, and individuals in the EEA or UK may lodge a complaint with their local
          supervisory authority.
        </p>
      </Section>

      <Section id="gpc" heading="13. Do Not Track and Global Privacy Control">
        <p>
          Because we do not track visitors across third-party sites or serve targeted advertising,
          there is no such activity for a browser signal to opt out of. We nonetheless honour the
          Global Privacy Control (GPC) signal as a valid opt-out request where applicable law requires
          it. Browsers send &ldquo;Do Not Track&rdquo; signals inconsistently and there is no agreed
          standard for responding to them.
        </p>
      </Section>

      <Section id="children" heading="14. Children's privacy">
        <p>
          The site is intended for businesses and is not directed to children under 18. We do not
          knowingly collect personal information from children. If you believe a child has provided us
          with information, email{' '}
          <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a> and we will delete it.
        </p>
      </Section>

      <Section id="international" heading="15. International visitors">
        <p>
          We operate in the United States, and our infrastructure providers store data in United
          States data centres. If you access the site from outside the United States, you understand
          that your information will be transferred to, stored in, and processed in the United States,
          where data protection laws may differ from those in your country. Where required, we rely on
          appropriate safeguards such as the European Commission&rsquo;s Standard Contractual Clauses
          for such transfers.
        </p>
      </Section>

      <Section id="changes" heading="16. Changes to this policy">
        <p>
          We may update this policy as our practices or the law change. We will revise the
          &ldquo;Last updated&rdquo; date at the top of this page, and for material changes we will
          provide additional notice — such as a notice on the site or an email to account holders —
          before the change takes effect.
        </p>
      </Section>

      <Section id="contact" heading="17. How to reach us">
        <p>
          {LEGAL.entity} is the controller of the personal information described in this policy. For
          any privacy question, request, or complaint:
        </p>
        <address className="legal-address">
          {LEGAL.entity} — Privacy
          <br />
          {LEGAL.mailingAddress}
          <br />
          <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>
        </address>
      </Section>
    </LegalLayout>
  );
}
