using System.Net;
using System.Net.Mail;

public class MailService
{
    public void Send(string to)
    {
        // Two matches in one file must still give one finding.
        var client = new SmtpClient("smtp.office365.com", 587) { EnableSsl = true };
        client.Credentials = new NetworkCredential("noreply@example.com", "S3cretPassw0rd!");
        var backup = new SmtpClient("smtp.office365.com", 25);
    }
}
