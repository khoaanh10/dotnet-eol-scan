using MailKit.Security;

public class OAuthMailService
{
    public void Connect(MailKit.Net.Smtp.SmtpClient client, string token)
    {
        client.Connect("smtp.office365.com", 587);
        client.Authenticate(new SaslMechanismOAuth2("alerts@example.com", token));
    }
}
