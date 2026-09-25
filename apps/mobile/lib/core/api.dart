import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'config.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.details, this.code});
  final String message;
  final int? statusCode;
  final String? code;
  final dynamic details;

  /// Détails lisibles (liste de problèmes renvoyée par le serveur).
  List<String> get detailLines {
    final d = details;
    if (d is List) {
      return d.map((e) {
        if (e is Map) {
          final label = e['label'] ?? e['field'];
          final msg = e['detail'] ?? e['message'];
          return [label, msg].where((x) => x != null && '$x'.isNotEmpty).join(' : ');
        }
        return '$e';
      }).toList();
    }
    return const [];
  }

  @override
  String toString() => message;
}

/// Client HTTP vers le backend. Le jeton de session est stocké dans le stockage sécurisé Android.
class ApiClient {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  final _storage = const FlutterSecureStorage();
  final Dio _dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 15),
    receiveTimeout: const Duration(seconds: 60),
    sendTimeout: const Duration(seconds: 120),
  ));
  String? _token;
  void Function()? onUnauthorized;

  Future<void> init() async {
    _dio.options.baseUrl = await AppConfig.backendUrl();
    try {
      _token = await _storage.read(key: 'session_token');
    } catch (_) {
      _token = null;
    }
  }

  String get baseUrl => _dio.options.baseUrl;
  bool get hasToken => _token != null;

  Future<void> setBaseUrl(String url) async {
    await AppConfig.setBackendUrl(url);
    _dio.options.baseUrl = await AppConfig.backendUrl();
  }

  Future<void> setToken(String? token) async {
    _token = token;
    try {
      if (token == null) {
        await _storage.delete(key: 'session_token');
      } else {
        await _storage.write(key: 'session_token', value: token);
      }
    } catch (_) {}
  }

  Options _opts() => Options(headers: {if (_token != null) 'Authorization': 'Bearer $_token'});

  Future<dynamic> get(String path, {Map<String, dynamic>? query}) =>
      _wrap(() => _dio.get(path, queryParameters: _cleanQuery(query), options: _opts()));
  Future<dynamic> post(String path, [Object? body]) =>
      _wrap(() => _dio.post(path, data: body ?? {}, options: _opts()));
  Future<dynamic> put(String path, [Object? body]) => _wrap(() => _dio.put(path, data: body ?? {}, options: _opts()));
  Future<dynamic> patch(String path, [Object? body]) =>
      _wrap(() => _dio.patch(path, data: body ?? {}, options: _opts()));
  Future<dynamic> delete(String path, {Map<String, dynamic>? query}) =>
      _wrap(() => _dio.delete(path, queryParameters: _cleanQuery(query), options: _opts()));

  Future<dynamic> upload(String path, {required List<int> bytes, required String filename, Map<String, String> fields = const {}}) {
    final form = FormData.fromMap({...fields, 'file': MultipartFile.fromBytes(bytes, filename: filename)});
    return _wrap(() => _dio.post(path, data: form, options: _opts()));
  }

  Map<String, dynamic>? _cleanQuery(Map<String, dynamic>? q) {
    if (q == null) return null;
    final out = <String, dynamic>{};
    q.forEach((k, v) {
      if (v != null && '$v'.isNotEmpty) out[k] = v;
    });
    return out;
  }

  Future<dynamic> _wrap(Future<Response<dynamic>> Function() call) async {
    try {
      final res = await call();
      return res.data;
    } on DioException catch (e) {
      final res = e.response;
      if (res == null) {
        throw ApiException(
          e.type == DioExceptionType.connectionTimeout || e.type == DioExceptionType.receiveTimeout
              ? 'Le serveur ne répond pas (délai dépassé)'
              : 'Serveur injoignable : vérifiez votre connexion internet et l’URL du backend',
        );
      }
      if (res.statusCode == 401 && _token != null) {
        await setToken(null);
        onUnauthorized?.call();
      }
      final data = res.data;
      if (data is Map) {
        throw ApiException('${data['message'] ?? 'Erreur ${res.statusCode}'}',
            statusCode: res.statusCode, details: data['details'], code: data['error']?.toString());
      }
      throw ApiException('Erreur ${res.statusCode}', statusCode: res.statusCode);
    }
  }
}

final api = ApiClient.instance;
