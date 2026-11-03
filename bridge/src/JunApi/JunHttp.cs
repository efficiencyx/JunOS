using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using MelonLoader.Utils;

namespace JunBridge.JunApi;

public static class JunHttp {
  // start.ps1 / start.sh drop JunOS's local CA here on every start, so
  // nobody has to trust it system wide just for the game
  private static readonly string caPath = Path.Combine(MelonEnvironment.UserDataDirectory, "JunBridge.ca.pem");

  public static HttpClient Create(string apiUrl, TimeSpan timeout, CookieContainer cookies = null) {
    var handler = new HttpClientHandler { UseCookies = cookies != null };
    if (cookies != null) {
      handler.CookieContainer = cookies;
    }
    var ca = LoadCa();
    if (ca != null) {
      handler.ServerCertificateCustomValidationCallback = (_, cert, _, errors) =>
        errors == SslPolicyErrors.None
        || (errors == SslPolicyErrors.RemoteCertificateChainErrors && cert != null && IssuedBy(cert, ca));
    }
    var baseUri = BaseUri(apiUrl);
    var client = new HttpClient(handler) { BaseAddress = baseUri, Timeout = timeout };
    // php 403s a cookie POST without one (require_same_origin)
    client.DefaultRequestHeaders.Add("Origin", baseUri.GetLeftPart(UriPartial.Authority));
    return client;
  }

  public static Uri BaseUri(string apiUrl) => new(apiUrl.EndsWith("/") ? apiUrl : apiUrl + "/");

  private static X509Certificate2 LoadCa() {
    try {
      return File.Exists(caPath) ? X509Certificate2.CreateFromPem(File.ReadAllText(caPath)) : null;
    } catch (Exception) {
      return null;
    }
  }

  private static bool IssuedBy(X509Certificate2 cert, X509Certificate2 ca) {
    using var chain = new X509Chain();
    chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
    chain.ChainPolicy.CustomTrustStore.Add(ca);
    chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
    return chain.Build(cert);
  }
}
